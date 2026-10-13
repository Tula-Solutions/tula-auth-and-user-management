require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The SwiftUI screens (`native/swift`, library `TulaAuthUI`) as a pod, for the Expo module
# of `@tula/expo-screens` (ADR 0063): a copy of the library's sources
# (`vendor/TulaAuthUI`, made by `scripts/vendor-native.ts` when the package is built),
# compiled under the library's own module name. See TulaAuth.podspec.
Pod::Spec.new do |s|
  s.name           = 'TulaAuthUI'
  s.version        = package['version']
  s.summary        = "Tula's SwiftUI screens, as @tula/expo-screens ships them."
  s.description    = "Tula's SwiftUI screens for sign-in, sign-up, password reset and the account, on the TulaAuth client. A copy of the Swift package's TulaAuthUI library, compiled for the Expo module of @tula/expo-screens."
  s.license        = package['license']
  s.author         = 'Tula'
  s.homepage       = 'https://github.com/Tula-Solutions/tula-auth-and-user-management'
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Tula-Solutions/tula-auth-and-user-management.git' }
  s.static_framework = true

  s.dependency 'TulaAuth'

  s.source_files = 'vendor/TulaAuthUI/**/*.swift'
  s.frameworks = 'SwiftUI', 'CoreImage'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
