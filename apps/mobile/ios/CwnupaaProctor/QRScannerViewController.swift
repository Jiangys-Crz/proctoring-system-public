import UIKit
import AVFoundation

protocol QRScannerDelegate: AnyObject {
    func qrScanner(_ scanner: QRScannerViewController, didScan text: String)
}

/// 二维码扫描（扫描电脑端配对二维码）
final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {

    weak var delegate: QRScannerDelegate?
    private var captureSession: AVCaptureSession?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        title = "扫描二维码"
        setupCapture()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession?.stopRunning()
    }

    private func setupCapture() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        let session = AVCaptureSession()
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        captureSession = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue else { return }
        captureSession?.stopRunning()
        delegate?.qrScanner(self, didScan: value)
        navigationController?.popViewController(animated: true)
    }
}
