# m3 플러그인 규격 (apiVersion 1)

사람과 코딩 에이전트 모두 이 문서만 보고 플러그인을 작성할 수 있도록 정리. 작성 후 `m3 plugin check [--remote]`로 검증.

## 1. 형태

- ES 모듈 1개. `default export` = 플러그인 객체 (또는 그 객체를 반환하는 함수, async 허용)
- 의존성 없이 작성 가능. 타입 힌트만 필요하면 `/** @type {import("my-mac-manager/plugin").Plugin} */`
- 파일 형식: `.mjs` / `.js`. `.ts`는 Node 22.18 이상(type stripping 지원)에서만 동작

```js
/** @type {import("my-mac-manager/plugin").Plugin} */
export default {
  name: "my-plugin",      // 필수. 소문자 · 숫자 · -
  apiVersion: 1,
  description: "한 줄 설명",
  // 아래 항목은 모두 선택
  vault, backup, services, collectors, commands, remoteFiles, agents, bootstrap, hooks, projectKeys,
};
```

뼈대 생성: `m3 plugin new <이름> --kind service|vault|backup|command` → `plugins/<이름>.mjs`

## 2. 로드 방식 (m3.toml)

| 설정 | 의미 |
|---|---|
| `plugins = ["./plugins/x.mjs", "foo"]` | 항상 로드. 서비스 · 수집기 · 명령 · 훅 제공용 |
| `[vault] use = "..."` | vault 슬롯 (1개) |
| `[backup] use = "..."` | backup 슬롯 (1개) |
| `[plugin.<name>]` | 해당 플러그인 설정 → `ctx.options` |

`use` / `plugins` 값 해석 순서:
1. 내장 이름: `bitwarden`, `restic`, `launchd`, `docker`, `compose`, `apps`, `heartbeat`, `logscan`, `ports`
2. `.` · `/` · `~`로 시작: m3.toml 기준 파일 경로
3. 그 외: npm 패키지. `foo` → `m3-plugin-foo`를 먼저 찾고, 없으면 `foo`. 탐색 위치: m3.toml 디렉토리의 `node_modules`, 그다음 m3 설치 위치(전역 설치 시 `npm i -g m3-plugin-foo`)

슬롯 플러그인의 `ctx.options` = 해당 테이블에서 `use`를 뺀 나머지 (`[vault]`, `[backup]`).

## 3. 실행 위치와 제약

| 위치 | 실행 코드 | 제약 |
|---|---|---|
| 관리하는 컴퓨터 (m3 실행) | 플러그인 JS 전체 | Node 22 이상 |
| 대상 Mac (ssh) | `collectors[].code`, `remoteFiles`, 셸 줄 | `/usr/bin/python3` 3.9 표준 라이브러리만 사용. pip 패키지 사용 불가. Homebrew 경로는 `/opt/homebrew/bin` 절대 경로 권장 (ssh 비로그인 셸 PATH에 없음) |

비밀값 규칙:
- 비밀값을 출력하거나 명령 인자로 넘기지 않음. stdin(`run(cmd, { stdin })`)으로 전달
- 비교는 해시로 (`compareCredentials` 참고)

## 4. Context (`ctx`)

모든 함수의 첫 인자.

| 항목 | 내용 |
|---|---|
| `config` | m3.toml 전체 |
| `root` | m3.toml 디렉토리 |
| `id` | 원격 이름 공간 (`[remote].id`, 기본 `m3`) |
| `options` | 이 플러그인의 설정 |
| `projects` | `[{ name, ...[projects.<name>] }]` |
| `remote.host` / `dir` / `credDir` / `helper` | ssh 호스트 / `~/` 기준 m3 디렉토리 / 자격 디렉토리 / LaunchDaemon 헬퍼 경로 |
| `remote.run(cmd, { stdin, check, timeout })` | stdout 반환. `check: false` 이면 실패 시 `null` (기본은 오류 메시지 후 종료) |
| `remote.script(zsh)` | 원격 login zsh 실행, 출력 그대로 표시 → exit code |
| `remote.tty(cmd)` | `ssh -t` 대화형 (sudo 입력) → exit code |
| `remote.python(code, args)` / `pythonLive(code, args)` | `/usr/bin/python3 -I -` 실행 → stdout / exit code |
| `ui.ok/bad/warn/dim/bold(s)` | 색상 문자열 |
| `ui.dur(sec)` | `5m`, `3h`, `2d4h` |
| `ui.ask(q)` | 한 줄 입력 |
| `ui.poll(desc, fn, { timeout, every, detail, stall })` | `fn()`이 참이 될 때까지 대기 |
| `probe({ check })` | 대상 Mac 상태 수집 (facts) |
| `withVault(fn)` | vault 열기 → `fn(vault)` → 항상 닫기 |
| `backup()` / `backupPlan()` | backup 슬롯 인스턴스 / 백업 대상 목록 |
| `status(names)` | `m3 status` 출력 |
| `fail(msg)` | 오류 출력 후 종료 |

## 5. 슬롯: vault

```js
vault: (ctx) => ({
  async open() {},                 // 잠금 해제. 마스터 비밀번호 등 대화형 입력은 stdio: "inherit"
  async close() {},                // 항상 호출됨 (세션 키 무효화)
  async sync() {},                 // 선택
  async get(name) {},              // 정확히 일치 1개 | null. 2개 이상이면 ctx.fail
  async list(prefix) {},           // 이름이 prefix 로 시작하는 항목 전체 (notes 포함)
  async putNote(name, content) {}, // 보안 메모 생성 또는 notes 교체
})
```

항목 형식 (`VaultItem`):

```js
{ name, notes, password, type, fields: [{ name, value }], files: [{ name, read: async () => "내용" }] }
```

m3가 vault를 쓰는 곳:
- `[vault].item` 항목: 백업 자격, Mac 로그인 암호 (`m3 creds`, `m3 login`, `m3 reboot`)
  - 자격 KEY=VALUE 수집 순서: notes의 `KEY=VALUE` 줄 → fields (이름의 마지막 `>` 뒤 부분) → `*.env` 첨부 → 별칭 첨부
  - 로그인 암호: `[vault].login_password_field` (기본 `password`) 필드, 없으면 `password`
- `[vault].env_prefix + <$HOME 기준 경로>` 보안 메모: `.env` 파일 원본 (`m3 env`)

예: 1Password CLI (`op`)라면 `get` = `op item get <name> --format json` 결과를 위 형식으로 변환, `putNote` = `op item create --category "Secure Note"` / `op item edit`.

## 6. 슬롯: backup

```js
backup: (ctx) => ({
  credentials: { required: ["KEY"], optional: [], aliases: { "필드 이름(소문자)": "KEY", "@password": "KEY" } },
  async writeCredentials(kv) {},          // kv(대문자 키) → 대상 Mac ~/${ctx.remote.credDir}, 권한 600
  async compareCredentials(kv) {},        // { KEY: "same" | "diff" | "none" }. 대상 Mac 에서 sha256 계산 후 비교
  async hasCredentials() {},
  async run(action) {},                   // "now" | "snapshots" | "verify" | "log" → exit code
  async restore(what, { name, target }) {},  // "secrets" | "dirs" | "data"
  restoreDataCommand(name) {},            // bootstrap 에서 프로젝트 setup 전에 대상 Mac 이 실행할 셸 명령
  remoteFiles() {}, remoteOptions() {}, agents() {},   // 선택: 설치 파일 / config.json 의 backup 값 / 예약 실행 plist
})
```

`ctx.backupPlan()` = `{ secrets, dirs, dirs_exclude, data: { 프로젝트: { backup, restore } } }`
- 경로는 `$HOME` 기준 상대 경로
- `data.backup`: stdout으로 덤프를 내는 셸 명령, `data.restore`: stdin으로 덤프를 받는 셸 명령

`m3 install`이 대상 Mac의 `~/<dir>/config.json`에 `{ id, dir, plan, backup: remoteOptions() }` 기록. 예약 실행 스크립트가 이 파일을 읽는 구조.

## 7. 서비스와 수집기

상태 확인 흐름: 모든 수집기의 Python 코드를 묶어 **ssh 1회**로 실행 → `facts` → 각 서비스의 `check(ctx, project, facts)` → 행 목록.

```js
collectors: [{
  name: "my_thing",                 // facts.my_thing. 소문자 · 숫자 · _
  arg: (ctx) => ({ paths: [...] }), // JSON 직렬화 가능한 값 → collect 의 arg
  code: String.raw`
def collect(arg, facts):
    # 사용 가능: sh(cmd_list, timeout=20) → stdout(실패 시 ""), HOME, parse_ts(line), etime_sec(s),
    #           json, os, re, glob, time, subprocess, shutil, datetime
    # facts: now, boot, console_user, procs[{pid,ppid,age,rss_mb,cmd}], ports[{port,addr,pid,cmd}], dirs, 앞선 수집기 결과
    return {...}
`,
}],
services: [{
  name: "my-thing",
  keys: ["my_thing"],               // 프로젝트에 이 키가 있을 때만 check/kinds/control/logs 호출
  check: (ctx, p, facts) => [{ ok: true, tag: "mything", what: "대상", info: "상태" }],  // tag 7자 이내
  kinds: (p) => ["mything×1"],     // m3 ls 요약
  control: (ctx, p, action) => ({ lines: ["원격 zsh 한 줄"], tty: [{ label, cmd }] }),  // start|stop|restart
  logs: (ctx, p, n) => ["원격 zsh 한 줄"],
  audit: (ctx, facts) => [{ title: "미등록 X", items: ["..."] }],   // note: true 면 참고 표시 (건수 제외)
}],
```

규칙:
- 수집기 예외는 `facts._errors[이름]`으로 기록되고 경고 표시. 다른 수집기는 계속 실행
- `check`는 동기 함수. 원격 호출이 필요하면 수집기에서 미리 수집
- 서비스 실행 순서 = 내장 (launchd, docker, compose, apps, heartbeat, logscan, ports) → `plugins` 목록 순서
- `control.lines`는 `U=$(id -u)` 정의 후 한 번에 실행. stop 일 때 전체 역순

## 8. 명령 · 원격 파일 · launchd · bootstrap · 훅

```js
commands: [{
  name: "my-cmd", summary: "한 줄", usage: "m3 my-cmd [--yes]",
  options: { yes: { type: "boolean" }, hours: { type: "string", short: "H" } },   // node:util parseArgs 형식
  async run(ctx, { values, positionals }) { return 0; },                          // exit code
}],
remoteFiles: (ctx) => [{ name: "my.py", content: "...", mode: 0o755 }],   // ~/<dir>/my.py (m3 install · host · bootstrap)
agents: (ctx) => [{ label: "com.me.job", plist: "<?xml ...>" }],          // ~/Library/LaunchAgents. __HOME__, __DIR__ 치환
bootstrap: (ctx) => [{ desc: "단계 설명", phase: "before-projects" | "finish", run: async (ctx) => 0 }],
hooks: { beforeReboot: (ctx, facts) => ["m3 reboot 확인 전 표시할 줄"] },
projectKeys: ["my_key"],   // 서비스 keys 외에 읽는 프로젝트 키 (m3 plugin check 의 알 수 없는 키 경고 제외)
```

- 명령 이름은 기본 명령과 겹칠 수 없음
- `agents` 라벨이 이미 LaunchDaemon으로 전환된 상태(`/Library/LaunchDaemons/<라벨>.plist` 존재)면 `m3 install` 시 LaunchDaemon 쪽에 다시 반영

## 9. 검증 체크리스트

- [ ] `m3 plugin check ./plugins/x.mjs` 오류 없음
- [ ] 수집기가 있으면 `m3 plugin check ./plugins/x.mjs --remote` (대상 Mac python 3.9 컴파일)
- [ ] 비밀값이 출력 · 명령 인자 · 로그에 남지 않음
- [ ] vault: `m3 creds check`, `m3 env status` 동작
- [ ] backup: `m3 backup snapshots`, `m3 backup verify` 동작
- [ ] 서비스: `m3 status <프로젝트>`, `m3 audit`

## 10. npm 배포

- 패키지 이름 `m3-plugin-<이름>` (또는 `@scope/m3-plugin-<이름>`), `"type": "module"`, `exports` 또는 `main` = 플러그인 파일
- `keywords`에 `m3-plugin` 포함
- 사용자: `npm i -g m3-plugin-<이름>` 또는 m3.toml 디렉토리에서 `npm i m3-plugin-<이름>` → `use = "<이름>"`
