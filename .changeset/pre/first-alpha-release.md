---
'@tula-tech/contract': patch
'@tula-tech/core': patch
'@tula-tech/react': patch
'@tula-tech/nextjs': patch
'@tula-tech/admin': patch
'@tula-tech/config': patch
'@tula-tech/mcp': patch
'@tula-tech/cli': patch
'create-tula': patch
---

The first release to npm, as alphas under the `alpha` dist-tag. Each of the nine packages
says where it comes from (`repository`, `homepage`, `bugs`, `keywords`), and its README says
how to install it and that the API may change between alphas. `@tula-tech/contract` has a README.

`@tula-tech/expo` and `@tula-tech/expo-screens` are held back until they have been run on a device.
`create-tula --framework expo` therefore refuses, before anything is written, to scaffold a
project that could not be installed, unless `--tula-packages` points it at tarballs from a
checkout of the repository.
