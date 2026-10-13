require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The iOS half of `@tula/expo/native-screens` (ADR 0063): an Expo module that draws Tula's
# SwiftUI screens on Tula's Swift client. The two libraries are the pods beside this one.
Pod::Spec.new do |s|
  s.name           = 'TulaExpoScreens'
  s.version        = package['version']
  s.summary        = "Tula's native sign-in, sign-up and account screens for an Expo app."
  s.description    = "The Expo module of @tula/expo/native-screens: Tula's SwiftUI screens as React Native views, and the session of the Swift client under them."
  s.license        = package['license']
  s.author         = 'Tula'
  s.homepage       = 'https://github.com/Tula-Solutions/tula-auth-and-user-management'
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Tula-Solutions/tula-auth-and-user-management.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'TulaAuth'
  s.dependency 'TulaAuthUI'

  s.source_files = 'TulaExpoScreens/**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
