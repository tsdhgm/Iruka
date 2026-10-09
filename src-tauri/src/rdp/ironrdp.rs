//! IronRDP バックエンド（IronRDP のブロッキング API を使用）。
//!
//! 1 セッションにつき 1 スレッドで、サーバーからの画面更新の受信とデコード、
//! フロントからの入力の送信を交互に行う。

use std::{
    io::Write as _,
    net::TcpStream,
    sync::{
        mpsc::{Receiver, TryRecvError},
        Arc,
    },
    time::{Duration, Instant},
};

use ironrdp_blocking::Framed;
use ironrdp_connector::{
    connection_activation::ConnectionActivationState,
    sspi::{network_client::NetworkClient, NetworkRequest},
    ClientConnector, ClientConnectorState, ConnectionResult, Credentials, DesktopSize, Sequence,
};
use ironrdp_core::WriteBuf;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_input::{Database, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp_pdu::{
    gcc::KeyboardType,
    geometry::{InclusiveRectangle, Rectangle as _},
    input::fast_path::FastPathInputEvent,
    rdp::{
        capability_sets::MajorPlatformType,
        client_info::{PerformanceFlags, TimezoneInfo},
    },
};
use ironrdp_session::{fast_path, image::DecodedImage, ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use rustls::pki_types::ServerName;

use super::{Command, FrameSink, FrameView, RdpBackend, RdpConnectParams, RdpInput, Rect};

type TlsStream = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

/// 受信待ちのタイムアウト。この間隔で入力キューも確認する。
const READ_TIMEOUT: Duration = Duration::from_millis(15);

/// IronRDP（Rust 製）によるバックエンド。RDPGFX には未対応なので、
/// GNOME Remote Desktop にはつながらない（Windows 向け）。
pub struct IronRdp;

impl RdpBackend for IronRdp {
    fn name(&self) -> &'static str {
        "IronRDP"
    }

    fn run(
        &self,
        params: &RdpConnectParams,
        commands: &Receiver<Command>,
        sink: &mut FrameSink,
    ) -> anyhow::Result<String> {
        run_session(params, commands, sink)
    }
}

fn run_session(params: &RdpConnectParams, rx: &Receiver<Command>, sink: &mut FrameSink) -> anyhow::Result<String> {
    use anyhow::Context as _;

    let (connection_result, mut framed) = connect(params, params.port()).context("接続に失敗しました")?;

    framed
        .get_inner()
        .0
        .sock
        .set_read_timeout(Some(READ_TIMEOUT))
        .context("set_read_timeout")?;

    let size = connection_result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    sink.resize(size.width.into(), size.height.into())?;

    let activation_factory = connection_result.activation_factory;
    let mut active_stage = ActiveStageBuilder {
        static_channels: connection_result.static_channels,
        user_channel_id: connection_result.user_channel_id,
        io_channel_id: connection_result.io_channel_id,
        message_channel_id: connection_result.message_channel_id,
        share_id: connection_result.share_id,
        compression_type: connection_result.compression_type,
        enable_server_pointer: connection_result.enable_server_pointer,
        pointer_software_rendering: connection_result.pointer_software_rendering,
    }
    .build();

    let mut input_db = Database::new();

    loop {
        // フロントからの入力を処理する
        let mut fastpath_events: Vec<FastPathInputEvent> = Vec::new();
        loop {
            match rx.try_recv() {
                Ok(Command::Input(inputs)) => {
                    for input in inputs {
                        fastpath_events.extend(apply_input(&mut input_db, &mut active_stage, input));
                    }
                }
                // クリップボードは未対応
                Ok(Command::ClipboardLocal(_)) => {}
                Ok(Command::Close) | Err(TryRecvError::Disconnected) => {
                    if let Ok(outputs) = active_stage.graceful_shutdown() {
                        for out in outputs {
                            if let ActiveStageOutput::ResponseFrame(frame) = out {
                                let _ = framed.write_all(&frame);
                            }
                        }
                    }
                    return Ok("切断しました".into());
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        if !fastpath_events.is_empty() {
            let outputs = active_stage.process_fastpath_input(&mut image, &fastpath_events)?;
            for out in outputs {
                match out {
                    ActiveStageOutput::ResponseFrame(frame) => framed.write_all(&frame)?,
                    ActiveStageOutput::GraphicsUpdate(rect) => sink.damage(to_rect(&rect)),
                    _ => {}
                }
            }
        }

        // サーバーからの PDU を処理する
        match framed.read_pdu() {
            Ok((action, payload)) => {
                let outputs = active_stage.process(&mut image, action, &payload)?;
                for out in outputs {
                    match out {
                        ActiveStageOutput::ResponseFrame(frame) => framed.write_all(&frame)?,
                        ActiveStageOutput::GraphicsUpdate(rect) => sink.damage(to_rect(&rect)),
                        ActiveStageOutput::Terminate(reason) => {
                            sink.flush(&view(&image), true)?;
                            return Ok(reason.description());
                        }
                        ActiveStageOutput::DeactivateAll => {
                            // Deactivation-Reactivation Sequence（ログオン直後や解像度変更時に来る）
                            let mut activation = activation_factory.create();
                            let mut buf = WriteBuf::new();
                            let (desktop_size, share_id, enable_server_pointer, pointer_software_rendering) = loop {
                                sequence_step(&mut framed, &mut activation, &mut buf)?;
                                if let ConnectionActivationState::Finalized {
                                    desktop_size,
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                } = activation.connection_activation_state()
                                {
                                    break (desktop_size, share_id, enable_server_pointer, pointer_software_rendering);
                                }
                            };
                            image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
                            active_stage.set_fastpath_processor(
                                fast_path::ProcessorBuilder {
                                    io_channel_id: activation.io_channel_id(),
                                    user_channel_id: activation.user_channel_id(),
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                    bulk_decompressor: None,
                                }
                                .build(),
                            );
                            active_stage.set_share_id(share_id);
                            active_stage.set_enable_server_pointer(enable_server_pointer);
                            sink.resize(desktop_size.width.into(), desktop_size.height.into())?;
                        }
                        _ => {}
                    }
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok("サーバーが接続を閉じました".into());
            }
            Err(e) => return Err(anyhow::Error::new(e).context("受信エラー")),
        }

        sink.flush(&view(&image), false)?;
    }
}

fn apply_input(
    db: &mut Database,
    active_stage: &mut ActiveStage,
    input: RdpInput,
) -> Vec<FastPathInputEvent> {
    let op = match input {
        RdpInput::MouseMove { x, y } => {
            active_stage.update_mouse_pos(x, y);
            Operation::MouseMove(MousePosition { x, y })
        }
        RdpInput::MouseButton { button, down } => {
            // MouseEvent.button → IronRDP の web ボタン番号
            let Some(button) = ironrdp_input::MouseButton::from_web_button(button) else {
                return Vec::new();
            };
            if down {
                Operation::MouseButtonPressed(button)
            } else {
                Operation::MouseButtonReleased(button)
            }
        }
        RdpInput::Wheel { vertical, units } => Operation::WheelRotations(WheelRotations {
            is_vertical: vertical,
            rotation_units: units,
        }),
        RdpInput::Key { scancode, down } => {
            let scancode = Scancode::from_u16(scancode);
            if down {
                Operation::KeyPressed(scancode)
            } else {
                Operation::KeyReleased(scancode)
            }
        }
        RdpInput::ReleaseAll => return db.release_all().into_vec(),
    };
    db.apply([op]).into_vec()
}

fn to_rect(r: &InclusiveRectangle) -> Rect {
    Rect {
        x: r.left.into(),
        y: r.top.into(),
        width: r.width().into(),
        height: r.height().into(),
    }
}

fn view(image: &DecodedImage) -> FrameView<'_> {
    FrameView {
        data: image.data(),
        width: image.width().into(),
        height: image.height().into(),
        stride: image.stride(),
    }
}

fn sequence_step(
    framed: &mut Framed<TlsStream>,
    sequence: &mut dyn Sequence,
    buf: &mut WriteBuf,
) -> anyhow::Result<()> {
    buf.clear();
    let written = if let Some(hint) = sequence.next_pdu_hint() {
        let pdu = loop {
            match framed.read_by_hint(hint) {
                Ok(pdu) => break pdu,
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(e) => return Err(e.into()),
            }
        };
        sequence.step(&pdu, buf)?
    } else {
        sequence.step_no_input(buf)?
    };
    if let Some(len) = written.size() {
        framed.write_all(&buf[..len])?;
    }
    Ok(())
}

fn connect(params: &RdpConnectParams, port: u16) -> anyhow::Result<(ConnectionResult, Framed<TlsStream>)> {
    use anyhow::Context as _;
    use std::net::ToSocketAddrs as _;

    let (domain, username) = params.domain_and_user();

    let config = ironrdp_connector::Config {
        credentials: Credentials::UsernamePassword {
            username,
            password: params.password.clone(),
        },
        domain,
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize {
            width: params.width,
            height: params.height,
        },
        bitmap: None,
        client_build: 0,
        client_name: "iruka".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: MajorPlatformType::UNIX,
        // カーソルはローカルのものを表示する（FreeRDP バックエンドと同じ）
        enable_server_pointer: false,
        pointer_software_rendering: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        compression_type: None,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    };

    let addr = (params.host.as_str(), port)
        .to_socket_addrs()
        .context("ホスト名を解決できません")?
        .next()
        .context("ホストのアドレスが見つかりません")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).context("TCP 接続")?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
    let client_addr = tcp.local_addr()?;

    let mut framed = Framed::new(tcp);
    let mut connector = ClientConnector::new(config, client_addr);
    let should_upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector).context("接続開始")?;

    let tcp = framed.into_inner_no_leftover();
    let (tls, server_public_key) = tls_upgrade(tcp, &params.host).context("TLS")?;
    let upgraded = ironrdp_blocking::mark_as_upgraded(should_upgrade, &mut connector);
    let mut framed = Framed::new(tls);

    let _ = upgraded;
    perform_credssp(&mut connector, &mut framed, params.host.clone().into(), server_public_key)
        .context("認証（ユーザー名・パスワードを確認してください）")?;
    let connection_result = finish_connection(connector, &mut framed).context("セッション開始")?;

    Ok((connection_result, framed))
}

/// ironrdp_blocking::connect_finalize の CredSSP 部分と同じ処理（Kerberos なし）。
fn perform_credssp(
    connector: &mut ClientConnector,
    framed: &mut Framed<TlsStream>,
    server_name: ironrdp_connector::ServerName,
    server_public_key: Vec<u8>,
) -> anyhow::Result<()> {
    use ironrdp_connector::credssp::CredsspSequence;
    use ironrdp_connector::sspi::generator::GeneratorState;

    if !connector.should_perform_credssp() {
        return Ok(());
    }
    let ClientConnectorState::Credssp { selected_protocol, .. } = connector.state else {
        anyhow::bail!("invalid connector state for CredSSP");
    };
    let (mut sequence, mut ts_request) = CredsspSequence::init(
        connector.config.credentials.clone(),
        connector.config.domain.as_deref(),
        selected_protocol,
        server_name,
        server_public_key,
        None,
    )?;
    let mut buf = WriteBuf::new();
    loop {
        let client_state = {
            let mut generator = sequence.process_ts_request(ts_request);
            let mut state = generator.start();
            loop {
                match state {
                    GeneratorState::Suspended(request) => {
                        state = generator.resume(NoNetworkClient.send(&request));
                    }
                    GeneratorState::Completed(result) => break result?,
                }
            }
        };
        buf.clear();
        let written = sequence.handle_process_result(client_state, &mut buf)?;
        if let Some(len) = written.size() {
            framed.write_all(&buf[..len])?;
        }
        let Some(hint) = sequence.next_pdu_hint() else {
            break;
        };
        let pdu = framed.read_by_hint(hint)?;
        match sequence.decode_server_message(&pdu)? {
            Some(next) => ts_request = next,
            None => break,
        }
    }
    connector.mark_credssp_as_done();
    Ok(())
}

/// CredSSP 以降の接続シーケンス。
///
/// IronRDP は接続時の帯域測定（Bandwidth Measure Stop）に応答しないが、
/// gnome-remote-desktop（FreeRDP ベース）は結果が返るまで次へ進まないため、
/// ConnectTimeAutoDetection の間だけ PDU を覗いてこちらで応答する。
fn finish_connection(mut connector: ClientConnector, framed: &mut Framed<TlsStream>) -> anyhow::Result<ConnectionResult> {
    let mut buf = WriteBuf::new();
    let mut bw: Option<(Instant, u32)> = None;
    loop {
        if let ClientConnectorState::ConnectTimeAutoDetection { user_channel_id, .. } = connector.state {
            let hint = connector.next_pdu_hint().ok_or_else(|| anyhow::anyhow!("auto-detect: no pdu hint"))?;
            let pdu = framed.read_by_hint(hint)?;
            if let Some(message_channel_id) = connector.message_channel_id {
                answer_bandwidth_measure(&pdu, message_channel_id, user_channel_id, &mut bw, framed)?;
            }
            buf.clear();
            let written = connector.step(&pdu, &mut buf)?;
            if let Some(len) = written.size() {
                framed.write_all(&buf[..len])?;
            }
        } else {
            ironrdp_blocking::single_sequence_step(framed, &mut connector, &mut buf)?;
        }
        if matches!(connector.state, ClientConnectorState::Connected { .. }) {
            let ClientConnectorState::Connected { result } = std::mem::take(&mut connector.state) else {
                unreachable!()
            };
            return Ok(result);
        }
    }
}

fn answer_bandwidth_measure(
    pdu: &[u8],
    message_channel_id: u16,
    user_channel_id: u16,
    bw: &mut Option<(Instant, u32)>,
    framed: &mut Framed<TlsStream>,
) -> anyhow::Result<()> {
    use ironrdp_pdu::rdp::autodetect::{
        AutoDetectReqPdu, AutoDetectRequest, AutoDetectResponse, AutoDetectRspPdu, BW_RESULTS_CONNECT_TIME,
        BW_RESULTS_CONTINUOUS, BW_STOP_CONNECT_TIME,
    };
    use ironrdp_pdu::{mcs::McsMessage, x224::X224};

    if let Some((_, bytes)) = bw.as_mut() {
        *bytes = bytes.saturating_add(u32::try_from(pdu.len()).unwrap_or(u32::MAX));
    }
    let Ok(X224(McsMessage::SendDataIndication(data))) = ironrdp_core::decode::<X224<McsMessage<'_>>>(pdu) else {
        return Ok(());
    };
    if data.channel_id != message_channel_id {
        return Ok(());
    }
    let Ok(req) = ironrdp_core::decode::<AutoDetectReqPdu>(&data.user_data) else {
        return Ok(());
    };
    match req.request {
        AutoDetectRequest::BandwidthMeasureStart { .. } => *bw = Some((Instant::now(), 0)),
        AutoDetectRequest::BandwidthMeasureStop {
            sequence_number,
            request_type,
            ..
        } => {
            let (start, byte_count) = bw.take().unwrap_or((Instant::now(), 0));
            let time_delta_ms = u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX).max(1);
            let response_type = if request_type == BW_STOP_CONNECT_TIME {
                BW_RESULTS_CONNECT_TIME
            } else {
                BW_RESULTS_CONTINUOUS
            };
            tracing::debug!(sequence_number, time_delta_ms, byte_count, "answer bandwidth measure");
            let response = AutoDetectRspPdu::new(AutoDetectResponse::BandwidthMeasureResults {
                sequence_number,
                response_type,
                time_delta_ms,
                byte_count,
            });
            let mut buf = WriteBuf::new();
            let len = ironrdp_connector::encode_send_data_request(user_channel_id, message_channel_id, &response, &mut buf)?;
            framed.write_all(&buf[..len])?;
        }
        _ => {}
    }
    Ok(())
}

/// Kerberos（KDC への通信）は使わず NTLM のみで認証するためのダミー。
struct NoNetworkClient;

impl NetworkClient for NoNetworkClient {
    fn send(&self, _request: &NetworkRequest) -> ironrdp_connector::sspi::Result<Vec<u8>> {
        Err(ironrdp_connector::sspi::Error::new(
            ironrdp_connector::sspi::ErrorKind::NoAuthenticatingAuthority,
            "Kerberos is not supported",
        ))
    }
}

fn tls_upgrade(tcp: TcpStream, host: &str) -> anyhow::Result<(TlsStream, Vec<u8>)> {
    use anyhow::Context as _;
    use x509_cert::der::Decode as _;

    // RDP サーバーは自己署名証明書が普通なので検証しない（mstsc の「続行」相当）
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(danger::NoCertificateVerification))
        .with_no_client_auth();
    // CredSSP は TLS セッション再開に対応していない
    config.resumption = rustls::client::Resumption::disabled();

    let server_name = ServerName::try_from(host.to_owned())?;
    let conn = rustls::ClientConnection::new(Arc::new(config), server_name)?;
    let mut tls = rustls::StreamOwned::new(conn, tcp);
    tls.flush()?;

    let cert = tls
        .conn
        .peer_certificates()
        .and_then(|certs| certs.first())
        .context("サーバー証明書がありません")?;
    let cert = x509_cert::Certificate::from_der(cert)?;
    let public_key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .context("公開鍵を取り出せません")?
        .to_owned();

    Ok((tls, public_key))
}

mod danger {
    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::{pki_types, DigitallySignedStruct, Error, SignatureScheme};

    #[derive(Debug)]
    pub(super) struct NoCertificateVerification;

    impl ServerCertVerifier for NoCertificateVerification {
        fn verify_server_cert(
            &self,
            _: &pki_types::CertificateDer<'_>,
            _: &[pki_types::CertificateDer<'_>],
            _: &pki_types::ServerName<'_>,
            _: &[u8],
            _: pki_types::UnixTime,
        ) -> Result<ServerCertVerified, Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _: &[u8],
            _: &pki_types::CertificateDer<'_>,
            _: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            rustls::crypto::ring::default_provider()
                .signature_verification_algorithms
                .supported_schemes()
        }
    }
}
