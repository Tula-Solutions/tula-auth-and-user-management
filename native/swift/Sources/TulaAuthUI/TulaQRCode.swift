import CoreGraphics
import CoreImage
import Foundation

/// Draws the QR code of an authenticator app's setup address.
///
/// The image is made by the system's own generator (CoreImage: the package has no
/// dependency), in memory, each time it is drawn. It is never written to a file, a cache or
/// the pasteboard, and nothing keeps it once its screen has gone.
enum TulaQRCode {
    /// The QR code of a text, one pixel a module, or `nil` when the system made none.
    ///
    /// - Parameter text: What the code holds: an `otpauth://` address.
    static func image(for text: String) -> CGImage? {
        guard !text.isEmpty, let filter = CIFilter(name: "CIQRCodeGenerator") else {
            return nil
        }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        // The middle level: a setup address is short, and a phone reads it off a screen.
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else {
            return nil
        }
        // A software context: nothing of the image is handed to a cache on the GPU.
        return CIContext(options: [.useSoftwareRenderer: true, .cacheIntermediates: false])
            .createCGImage(output, from: output.extent)
    }
}
