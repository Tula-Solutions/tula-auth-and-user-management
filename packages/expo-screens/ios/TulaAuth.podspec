require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The Swift client (`native/swift`, library `TulaAuth`) as a pod, for the Expo module of
# `@tula-tech/expo-screens` (ADR 0063). The Swift package is published nowhere, and a pod
# cannot depend on a Swift package, so the npm package carries a copy of the library's
# sources (`vendor/TulaAuth`, made by `scripts/vendor-native.ts` when the package is built)
# and this file compiles them under the library's own module name.
Pod::Spec.new do |s|
  s.name           = 'TulaAuth'
  s.version        = package['version']
  s.summary        = "Tula's Swift client, as @tula-tech/expo-screens ships it."
  s.description    = "Tula's Swift client with no screen: flows, the session, the refresh token in the Keychain. A copy of the Swift package's TulaAuth library, compiled for the Expo module of @tula-tech/expo-screens."
  s.license        = package['license']
  s.author         = 'Tula'
  s.homepage       = 'https://github.com/Tula-Solutions/tula-auth-and-user-management'
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Tula-Solutions/tula-auth-and-user-management.git' }
  s.static_framework = true

  s.source_files = 'vendor/TulaAuth/**/*.swift'
  s.frameworks = 'Foundation', 'Security', 'CryptoKit', 'AuthenticationServices'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
