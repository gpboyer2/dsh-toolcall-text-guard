# dsh-toolcall-text-guard

> **Writing `turn/end completed` does not mean the work is done.** —— It stops "calling it done before finishing" at the moment of wrap-up, and puts the same turn back on track with one hint.

[English](README.en.md) · [简体中文](README.md)

![DSH](https://img.shields.io/badge/DSH-DeepSeek%20Harness-1F6FEB?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Cordis](https://img.shields.io/badge/Cordis-plugin-FF6B6B?style=flat-square)
![tests](https://img.shields.io/badge/tests-35-brightgreen?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin. A long task stops halfway, the UI sits still, but the turn has already ended. The plugin hooks `agent/turn-stopping` and decides by structure whether the last step really finished. If not, it appends one sentence to the same turn and keeps it going.

## What it solves

You hand over a job that takes several steps. It works for a while, then stops moving. The UI freezes, but the turn writes `turn/end completed` as usual.

- Send one more "continue" and it picks up again. Install it.
- The work is not done, yet the turn is taken as "finished" and closed. The plugin intercepts at the moment of wrap-up. This can be saved.
- The process crashes outright, the event stream breaks mid-way. There is no moment to intervene, so it cannot be saved. Don't install it.
- A plain Q&A turn that never called a tool. No need to install.
- No conflict with the built-in `@deepseek-ai/dsh-text-toolcall-guard`: that one only covers one form, a `<tool_call>` marker at the start of a line.

Whether `turn/end completed` appears at the end only separates "the process is still alive" from "the process crashed". It is not a decision condition. The UI has stopped while the turn is written complete — that is the most common kind of break.

## How it works

```mermaid
flowchart TD
    N1["1 You speak"] --> N2["2 DSH starts a turn"]
    N2 --> N3["3 The model keeps working: writes reasoning, writes text, or makes a real tool call"]
    N3 --> N4["4 Checkpoint before wrap-up: agent/turn-stopping, before turn/end"]
    N4 --> N5{"5 Gates: enabled / has a message / last step made no tool call / this turn made a tool call"}
    N5 -->|all four pass| N6{"6 Check the last step in order"}
    N5 -->|any fails| N9["9 Turn wraps up"]
    N6 -->|matches a break type| N7{"7 Count and degeneration guard"}
    N6 -->|no match| N9
    N7 -->|under 6 times and effective| N8["8 Steer one sentence with agent.steer, text chosen by break type"]
    N7 -->|6 times reached or recovery ineffective| N9
    N8 -->|after steering| N3
```

- **Gates**, all four must pass before any check: the switch is on, this turn has a message, this turn made at least one real `tool-call`, and the last step made no `tool-call`. Exception: `reasoning-echo` is not bound by "this turn called a tool"; a pure Q&A turn can also write its reasoning into the body.
- **Structure only**: no judge model, no extra tokens. The data is this turn's event stream.
- **Steer with `agent.steer`**: append one sentence to the same turn, text chosen by break type, no new turn.
- **Guards**: at most 6 steers per round. On each steer it records the event count; if another steer is needed and the count has not grown, it stops and writes one `give-up` line. Count and progress are kept per "session + turn number", so counts used in session A do not land on session B.

## Break types it recognizes

Checks run in order and stop at the first match. By group:

| Group | Check | Steer? |
| --- | --- | --- |
| Gate | `disabled` / `no-message` / `last-step-called-tool` / `no-tool-anywhere` | No |
| Empty reply | `reasoning-only`, `blank-after-tool` | Yes |
| Fuhua-channel deliverable | `fuhua-no-report`: the model name starts with `fuhua/` or `fuhua-mac/`, a tool was called, but the last step has no "Current status" and "What was done" sections | Yes |
| Reasoning leak | `leak-unclosed`, `leak-no-body`, `leak-inner-unclosed`, `leak-residual-tag`, `leak-call-head`, `leak-has-body` | The first five yes, `leak-has-body` no |
| Degenerate repeated leak | `degenerate-leak`: two or more lines start with a closing tag, and body text remains after stripping the tag | Yes |
| Trailing tag at wrap-up | `leak-tail-stub`: the last sentence drags a reasoning closing tag; after stripping it is no more than 80 chars with no substantive content | Yes |
| Long text | `text-too-long`: body exceeds `maxChars` 8000 | No |
| Fragment | `tag-shape`, `tag-residual`, `json-tool-call`, `call-head`, `tag-head` | Yes |
| Exposed tags | `exposed-call-tag`: `<parameter name=…>`, two or more `</parameter>`, or two or more `</thought>` visible in the body | Yes |
| Half sentence | `half-sentence`: stops on a comma, semicolon, colon, or dash, no more than 200 chars | Yes |
| Plan tail | `plan-tail`, `leak-plan-tail`: the whole turn is calling tools, and the last step leaves only "now / next / finally + what to do", then stops. No more than 300 chars, no heading, no link, no closing question mark, no statement of completion, no waiting word | Yes |
| Reasoning echo | `reasoning-echo`: body and reasoning are almost the same passage (the shorter is at least 85% of the longer, and both are ≥200 chars) | Yes |
| Looks finished | `looks-complete` | No |

Exposed tags is the most direct kind: normally DSH folds calls into "read file / ran command" cards, and once these tags are visibly printed in the body, the call has degenerated into text. The check strips code blocks and inline code first, so that "discussing tags" is not mistaken for degeneration.

## Quick start

```sh
# 1. Clone into ~/.dsh/plugins/dsh-toolcall-text-guard
git clone https://github.com/gpboyer2/dsh-toolcall-text-guard.git ~/.dsh/plugins/dsh-toolcall-text-guard

# 2. Register with a profile (a CLI-managed profile, such as web / main)
dsh plugin --profile <your-profile> add link:$HOME/.dsh/plugins/dsh-toolcall-text-guard

# 3. Restart DSH
```

> The `desktop` profile is owned exclusively by DeepSeek Harness.app; `dsh plugin --profile desktop …` from the CLI is rejected. On desktop, install it from the in-app "Plugins" page, or edit the profile's `dependencies` + symlink manually, then restart.

The bundled `cordis.patch.yml` inserts the layer stack automatically. No need to edit the profile's patch file by hand.

**Verify**: after restart, run one turn and check whether `~/.dsh/logs/toolcall-guard.log` has new lines. New lines mean it loaded.

## Core features

| Capability | Description |
| --- | --- |
| **Structural checks** | Looks only at this turn's event structure, no judge model, no extra tokens. |
| **Rejoin the same turn** | Steers one sentence with `agent.steer`; no new turn, no lost context. |
| **Text chosen by break type** | Empty reply, half sentence, tag leak, plan tail each get their own hint. |
| **Two gates** | This turn called a tool (`reasoning-echo` excepted), and the last step did not, to avoid hitting normal wrap-ups. |
| **Count guard** | At most 6 per round; if the event count does not grow after recovery, stop and write `give-up`. |
| **Per-session accounting** | Count and progress are kept per "session + turn number"; sessions do not mix. |
| **Can be turned off** | `enabled: false` or `debug: false` writes no log lines. |
| **Zero dependencies** | Uses only services injected by DSH and Node built-in modules. |

## Configuration

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `maxContinuations` | `6` | Maximum steers per round. |
| `halfSentenceMax` | `200` | Length limit for the half-sentence check. |
| `fragmentMax` | `400` | Length limit for the fragment check. |
| `maxChars` | `8000` | Ordinary long text above this is no longer intercepted. |
| `debug` | `true` | Writes one log line per check. |
| `logFile` | `~/.dsh/logs/toolcall-guard.log` | Log location. |
| `steerText*` | see `index.js` | Steer text for each break type. |

`steerText*` means `steerText`, `steerTextBlank`, `steerTextReasoning`, `steerTextHalf`, `steerTextLeak`.

## Logs

One line per check, fixed fields:

```text
<time> | turn=<turn number> | step=<step> | why=<check> | recover=<true|false> | model=<model name> | used=<steers used> | text="<first 80 chars, placeholder>"
```

`debug` defaults to `true`. The first 80 chars of the last-step text go into the log. The log stays on this machine; nothing is uploaded. With `debug: false` nothing is written, including `give-up` and `steer-failed`. To change the location, edit `logFile`.

## Architecture

```
index.js              all plugin logic: turn-stopping listener, structural checks, guards, steer text, logging
cordis.patch.yml      bundle patch: inserts the layer stack
test/                 35 tests (checks, logging, message shapes)
```

Design constraint: it intervenes only at `agent/turn-stopping`; it does not read files, create sessions, or change turn state.

## Development and tests

```sh
npm test
node --test test/*.test.mjs
```

35 tests: check decisions and false-positive boundaries for each break type, the count guard and `give-up`, log fields and `debug: false`, message shapes.

## Known limits

- **A real process crash cannot be saved**: the event stream breaks mid-way and no wrap-up record is written, so the plugin has no moment to intervene.
- **Only known shapes are recognized**: a new break type is either unrecognized or let through by `looks-complete`; adding one check is enough.
- **Stops when the model keeps ignoring it**: at most 6 per round, and it also stops when the event count does not grow.
- **Requires a restart to take effect**: the host half is an in-process module.
- **Depends on the `agent/turn-stopping` seam**: if upstream changes that event point, this must change too.

## License

[MIT](LICENSE)
