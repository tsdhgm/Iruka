#! /bin/bash
# Start the release build from this repository (built with `npx tauri build --no-bundle`) and
# show its exit status. Check that no other Iruka is running first: a second start kills the
# running one (KNOWN_ISSUES.md).
cd "$(dirname "$0")"
src-tauri/target/release/iruka ; echo "exit=$?"
