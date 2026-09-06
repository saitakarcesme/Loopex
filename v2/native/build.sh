#!/bin/sh
set -eu
NATIVE_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
/usr/bin/xcrun swiftc -parse-as-library -O "$NATIVE_DIRECTORY/ComputerBridge.swift" -o "$NATIVE_DIRECTORY/akorith-computer" -framework AppKit -framework ScreenCaptureKit -framework ApplicationServices

/usr/bin/xcrun clang -O2 -Wall -Wextra -Werror "$NATIVE_DIRECTORY/ProcessSession.c" -o "$NATIVE_DIRECTORY/akorith-process-session"
