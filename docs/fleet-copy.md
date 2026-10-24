# The fleet repo, kept on the servers — encrypted

Lose the machine you run fornax on and the servers keep running, but their description is gone. With `fleet_copy`, every apply leaves the fleet repo (history included, `.fornax/` left out) on the server — encrypted to age recipients the server cannot use, and signed with the fleet's SSH key:

```yaml
fleet_copy:
  recipients:
    - age1…   # a hardware key: age-plugin-fido2-hmac -g, "separate identity" (encrypting then needs no key)
    - age1…   # a second hardware key
    - age1…   # a paper key (age-keygen), kept offline — the way back if both keys are gone
```

```bash
fornax fleet copies                       # which server holds which copy, signature ok?
fornax fleet push                         # now, to every server (apply does it by itself)
fornax fleet restore ~/fleet --from root@web-1,root@web-2 --signer <fleet key's public key> --identity <age identity>
```

`restore` needs no fleet config — it is what comes back: ssh to a server, the fleet key's public key and one identity. It takes the newest copy whose signature holds. The signature matters: anyone can encrypt to a public recipient, so a broken-into server could otherwise leave a fleet of its own making for your next apply to run as root everywhere.
