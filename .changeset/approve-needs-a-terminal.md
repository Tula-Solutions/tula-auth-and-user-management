---
'@tula-tech/cli': minor
---

`tula approve` requires a terminal, and `--yes` is removed from it. The question (which
names the operation and what it is carried out on) is asked at a terminal and answered by
typing `yes`; where standard input and standard error are not both a terminal the command
refuses before it reads or changes anything, whatever options it was given. `--json` still
asks, and prints the proposal on standard error first. `--secret-key-file -` is refused
for this command: standard input is where the answer is typed, so the key comes from a
file or the environment.

An approval is a person's act with their own credential: an assistant that can run shell
commands can no longer approve its own proposal by running the command non-interactively.
The cost is that nothing approves through `tula approve` from a script or CI. It does not
stop a program that drives a pseudo-terminal; what does is keeping the secret key away
from the assistant. `tula apply --yes` is unchanged.
