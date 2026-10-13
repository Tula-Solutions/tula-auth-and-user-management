---
'@tula/contract': patch
'@tula/core': patch
'@tula/react': patch
'@tula/nextjs': patch
'@tula/admin': patch
'@tula/config': patch
'@tula/mcp': patch
'@tula/cli': patch
'create-tula': patch
---

The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
how to install it and that the API may change between alphas. `@tula/contract` has a README.

`@tula/expo` and `@tula/expo-screens` are held back until they have been run on a device.
`create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
project that could not be installed, unless `--tula-packages` points it at tarballs from a
checkout of the repository.
