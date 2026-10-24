# History: how a server got to where it is

Three questions, one source each — nothing is recorded twice:

| | source | its history |
| --- | --- | --- |
| how it should be | the fleet repo | its git log |
| how it is | the server | /etc in git on the server (etckeeper) |
| who changed what, when | — | fornax's commits there link the two |

Every server keeps /etc in git (`history: true`, the default; private keys and generated secrets are never in it). Around each change fornax commits twice: first whatever changed since the last commit, as "outside fornax", then its own change with the plan, the fleet commit and who ran it. etckeeper adds package updates and a daily commit by itself. So when `fornax plan` shows a difference, `fornax history` says how it came about:

```bash
fornax history web-1 --path ufw      # now: changed since the last commit, not by fornax: ufw/user.rules
                                     # a8471b6  … fornax    2 change(s) by plan e08fdd0c (alex@laptop, fleet 5dc5475)
                                     # 370c753  … outside   changes found before fornax run …
fornax history web-1 --show 370c753  # the diff: who opened port 5555
```

Set `FORNAX_ACTOR` to name an agent or a CI job in these commits; otherwise it is `user@host`.
