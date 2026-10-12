# How to review a page (about 15 minutes per capability)

The scripts prove that the links are real. Only a person can prove that the statements are **true**. A page is `draft` until you have done this and signed it.

1. **Read Purpose and Known gaps first.** Purpose should match what you believe the capability is for. Known gaps is where the page admits what it could not
   prove; a gap you did not expect is the most valuable thing on the page.
2. **For every rule and behavior, read the sentence, then open its proof.** `[proof: S13 AS-07]` means a test whose title starts with `S13 AS-07`. Search for
   it (`grep -rn "S13 AS-07" packages`), read the test, and confirm that it checks the **number, status code or condition** the sentence states. The script
   only checks that the test exists.
3. **Pick the three rules you find most surprising and check them in the code** (`[code: path#Symbol]` takes you there). Numbers (limits, timeouts, status
   codes) are where a generated page is most likely to be wrong.
4. **Check that nothing is missing.** Think of what the capability must do that you do not see in Rules or Behaviors. Add it, with `[proof: none]` if no
   test covers it. A missing rule is invisible to every script.
5. **Fix what is wrong by editing the page**, run `python3 scripts/livespec/check.py`, then sign: `python3 scripts/livespec/sign.py sign S13`.

Order: start with the money and identity pages (S13, S10, S01), then the rest. Concept pages are short: read them after the capabilities that use them.

After signing, any change to a signed rule or behavior is reported (`check.py` fails) until you read it and sign again. Code that changes under a page's scope
without the page changing is reported as a warning at every checkpoint.

## Commands
- `python3 scripts/livespec/check.py` the whole graph (`--strict` makes warnings fail; `--base origin/master` adds the code-versus-page check)
- `python3 scripts/livespec/sign.py status` what is signed, and what changed since
- `python3 scripts/livespec/sign.py sign <id> [--only S13.R-01,S13.B-02]` sign a page or some items
- `python3 scripts/livespec/models.py check` and `python3 scripts/livespec/run_models.py` the state machines and the Quint models
- `python3 scripts/livespec/generate.py --only S99` the first draft of a page for a newly built capability (the build loop does this by itself)
