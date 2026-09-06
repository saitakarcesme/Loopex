import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

enum BridgeError: Error, CustomStringConvertible {
    case message(String)
    var description: String { switch self { case .message(let value): return value } }
}

func fail(_ text: String) throws -> Never { throw BridgeError.message(text) }
func trust(_ prompt: Bool = false) -> Bool {
    AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
    return result
}
func application(_ input: [String: Any]) throws -> NSRunningApplication {
    guard let bundle = input["bundleId"] as? String, !bundle.isEmpty else { try fail("Select an application before using computer tools.") }
    let candidates = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle && !$0.isTerminated }
    let requestedPID = input["pid"] as? Int
    guard let app = requestedPID.map({ pid in candidates.first(where: { Int($0.processIdentifier) == pid }) }) ?? candidates.sorted(by: { ($0.launchDate ?? .distantPast) > ($1.launchDate ?? .distantPast) }).first else { try fail("The selected application is no longer running.") }
    return app
}
func verifyFrontmost(_ app: NSRunningApplication) throws {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { try fail("The selected application is no longer in front. Select it again before sending input.") }
}
func state() -> [String: Any] {
    let apps: [[String: Any]] = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }.map {
        ["name": $0.localizedName ?? "Application", "bundleId": $0.bundleIdentifier ?? "", "pid": Int($0.processIdentifier), "active": $0.isActive]
    }
    return ["accessibility": trust(), "screenRecording": CGPreflightScreenCaptureAccess(), "apps": apps, "platform": "macOS"]
}

func accessibilitySnapshot(_ app: NSRunningApplication) throws -> [String: Any] {
    guard trust() else { try fail("Accessibility permission is not granted. Enable Akorith Next in System Settings → Privacy & Security → Accessibility.") }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 2)
    var count = 0
    func walk(_ element: AXUIElement, _ depth: Int) -> [String: Any] {
        count += 1
        var node: [String: Any] = [:]
        for (name, key) in [(kAXRoleAttribute, "role"), (kAXTitleAttribute, "title"), (kAXDescriptionAttribute, "description")] {
            if let value = attribute(element, name) as? String, !value.isEmpty { node[key] = String(value.prefix(500)) }
        }
        let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
        if subrole != kAXSecureTextFieldSubrole, let value = attribute(element, kAXValueAttribute) as? String, !value.isEmpty { node["value"] = String(value.prefix(1000)) }
        if let raw = attribute(element, kAXPositionAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
            var point = CGPoint.zero
            if AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cgPoint, &point) { node["x"] = point.x; node["y"] = point.y }
        }
        if let raw = attribute(element, kAXSizeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
            var size = CGSize.zero
            if AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cgSize, &size) { node["width"] = size.width; node["height"] = size.height }
        }
        if depth < 7 && count < 250 {
            let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            var output: [[String: Any]] = []
            for child in children.prefix(60) {
                if count >= 250 { break }
                let role = attribute(child, kAXRoleAttribute) as? String ?? ""
                // Collapsed menus contain unrelated recent-document names and are not visible controls.
                if role == kAXMenuRole || role == kAXMenuBarRole { continue }
                output.append(walk(child, depth + 1))
            }
            node["children"] = output
        }
        return node
    }
    var tree = walk(root, 0)
    if let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty {
        count = 0
        tree["children"] = windows.prefix(12).map { walk($0, 0) }
    }
    return ["bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "tree": tree, "truncated": count >= 250, "coordinateSpace": "global screen points, origin top-left"]
}

@available(macOS 14.0, *)
func capture(_ input: [String: Any]) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { try fail("Screen Recording permission is not granted. Enable Akorith Next in System Settings → Privacy & Security → Screen & System Audio Recording.") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let filter: SCContentFilter
    let frame: CGRect
    if input["bundleId"] is String {
        let app = try application(input)
        let requestedId = input["windowId"] as? Int
        let candidates = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 && $0.frame.width > 1 && $0.frame.height > 1 }
        guard let window = requestedId.flatMap({ id in candidates.first(where: { Int($0.windowID) == id }) }) ?? candidates.first else { try fail("No visible window was found for the selected application.") }
        filter = SCContentFilter(desktopIndependentWindow: window)
        frame = window.frame
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { try fail("No screen is available to capture.") }
        filter = SCContentFilter(display: display, excludingWindows: [])
        frame = display.frame
    }
    let config = SCStreamConfiguration()
    let scale = min(2, max(1, 1800 / max(frame.width, frame.height)))
    config.width = Int(frame.width * scale); config.height = Int(frame.height * scale)
    config.showsCursor = true; config.capturesAudio = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { try fail("Could not encode screenshot.") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { try fail("Could not finish screenshot encoding.") }
    return ["dataUrl": "data:image/png;base64," + (data as Data).base64EncodedString(), "width": image.width, "height": image.height, "originX": frame.origin.x, "originY": frame.origin.y, "scale": scale, "coordinateSpace": "Input uses global screen points, not screenshot pixels. Divide image pixels by scale, then add origin."]
}

func mouse(_ input: [String: Any], app: NSRunningApplication) throws -> [String: Any] {
    try verifyFrontmost(app)
    guard let x = input["x"] as? Double, let y = input["y"] as? Double, x.isFinite, y.isFinite else { try fail("Click requires finite global screen coordinates x and y.") }
    let point = CGPoint(x: x, y: y)
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let inWindow = windows.contains { window in
        guard let position = attribute(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(), let dimensions = attribute(window, kAXSizeAttribute), CFGetTypeID(dimensions) == AXValueGetTypeID() else { return false }
        var origin = CGPoint.zero; var size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &origin), AXValueGetValue(unsafeBitCast(dimensions, to: AXValue.self), .cgSize, &size) else { return false }
        return CGRect(origin: origin, size: size).contains(point)
    }
    guard inWindow else { try fail("The click point is outside the selected application's windows. Use coordinates from its current snapshot.") }
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &element) == .success, let element else { try fail("No accessible element in the selected application was found at that point.") }
    var owner: pid_t = 0
    AXUIElementGetPid(element, &owner)
    guard owner == app.processIdentifier else { try fail("The click target belongs to another application (observed process \(owner), selected process \(app.processIdentifier)). Select the correct app first.") }
    let right = (input["button"] as? String) == "right"
    let count = min(2, max(1, input["clickCount"] as? Int ?? 1))
    for index in 1...count {
        try verifyFrontmost(app)
        let down = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: right ? .right : .left)
        let up = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: right ? .right : .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(index)); up?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
    }
    Thread.sleep(forTimeInterval: 0.06)
    return ["ok": true]
}

func keyboard(_ input: [String: Any], app: NSRunningApplication, typing: Bool) throws -> [String: Any] {
    try verifyFrontmost(app)
    if typing {
        guard let text = input["text"] as? String, text.utf16.count <= 10000 else { try fail("Text input is limited to 10,000 characters.") }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        if let raw = attribute(root, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
            let focused = unsafeBitCast(raw, to: AXUIElement.self)
            if AXUIElementSetAttributeValue(focused, kAXSelectedTextAttribute as CFString, text as CFString) == .success {
                Thread.sleep(forTimeInterval: 0.06)
                return ["ok": true, "method": "accessibility insertion"]
            }
        }
        let units = Array(text.utf16)
        for offset in stride(from: 0, to: units.count, by: 20) {
            try verifyFrontmost(app)
            var part = Array(units[offset..<min(offset + 20, units.count)])
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            event?.keyboardSetUnicodeString(stringLength: part.count, unicodeString: &part)
            event?.post(tap: .cghidEventTap)
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            up?.keyboardSetUnicodeString(stringLength: part.count, unicodeString: &part)
            up?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.02)
        }
    } else {
        let map: [String: CGKeyCode] = ["enter": 36, "tab": 48, "escape": 53, "backspace": 51, "delete": 117, "space": 49, "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "s": 1, "f": 3, "l": 37, "n": 45, "w": 13]
        guard let key = input["key"] as? String, let code = map[key.lowercased()] else { try fail("Unsupported key. Use enter, tab, escape, arrows, home/end, pageup/pagedown or a/c/v/x/z/s/f/l/n/w.") }
        var flags: CGEventFlags = []
        for modifier in input["modifiers"] as? [String] ?? [] {
            switch modifier.lowercased() { case "command", "meta": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "alt", "option": flags.insert(.maskAlternate); case "control", "ctrl": flags.insert(.maskControl); default: try fail("Unsupported modifier.") }
        }
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true); down?.flags = flags; down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false); up?.flags = flags; up?.post(tap: .cghidEventTap)
    }
    Thread.sleep(forTimeInterval: 0.06)
    return ["ok": true]
}

@main struct ComputerBridge {
    static func main() async {
        do {
            let raw = FileHandle.standardInput.readDataToEndOfFile()
            guard raw.count <= 128 * 1024, let input = try JSONSerialization.jsonObject(with: raw) as? [String: Any], let action = input["action"] as? String else { try fail("Expected a JSON request with an action.") }
            let result: [String: Any]
            switch action {
            case "state": result = state()
            case "permissions":
                _ = trust(true)
                if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
                result = state()
            case "capture":
                // ScreenCaptureKit needs a WindowServer connection even in a short-lived helper.
                await MainActor.run { _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited) }
                if #available(macOS 14.0, *) { result = try await capture(input) } else { try fail("Screen capture requires macOS 14 or newer.") }
            case "select":
                let app = try application(input)
                guard trust() else { try fail("Accessibility permission is required to select and control an application.") }
                app.activate(options: [])
                try await Task.sleep(nanoseconds: 200_000_000)
                try verifyFrontmost(app)
                let root = AXUIElementCreateApplication(app.processIdentifier)
                if let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement], let window = windows.first {
                    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                    try await Task.sleep(nanoseconds: 120_000_000)
                    try verifyFrontmost(app)
                }
                result = ["ok": true, "bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? "Application", "pid": Int(app.processIdentifier)]
            case "snapshot": result = try accessibilitySnapshot(application(input))
            case "click", "type", "key":
                guard trust() else { try fail("Accessibility permission is not granted. Enable it before sending input.") }
                let app = try application(input)
                result = action == "click" ? try mouse(input, app: app) : try keyboard(input, app: app, typing: action == "type")
            default: try fail("Unknown computer action.")
            }
            let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            FileHandle.standardOutput.write(output)
        } catch {
            let output = try! JSONSerialization.data(withJSONObject: ["error": String(describing: error)], options: [.sortedKeys])
            FileHandle.standardOutput.write(output)
            exit(1)
        }
    }
}
