import AppKit

final class LabDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var field: NSTextField!
    var output: NSTextField!
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 520, height: 280), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Akorith Native Test Lab"
        let label = NSTextField(labelWithString: "Disposable test window — no user documents")
        label.frame = NSRect(x: 30, y: 220, width: 460, height: 28)
        field = NSTextField(frame: NSRect(x: 30, y: 160, width: 460, height: 30)); field.placeholderString = "Test input"; field.setAccessibilityLabel("Test input")
        let button = NSButton(title: "Apply test", target: self, action: #selector(apply))
        button.frame = NSRect(x: 30, y: 105, width: 130, height: 36)
        output = NSTextField(labelWithString: "Waiting for test")
        output.frame = NSRect(x: 30, y: 50, width: 460, height: 28)
        for view in [label, field!, button, output!] { window.contentView?.addSubview(view) }
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc func apply() { output.stringValue = "Hello " + field.stringValue }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = LabDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
