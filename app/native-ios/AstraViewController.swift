import UIKit
import Capacitor

/// ลงทะเบียน plugin เสียง native ของแอป
class AstraViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VoiceEnginePlugin())
    }
}
