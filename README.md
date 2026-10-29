# my-mac-manager (`m3`)

다른 컴퓨터에서 ssh로 headless Mac(Mac mini, EC2 Mac)을 관리하는 CLI.
상태 점검 · 서비스 제어 · 백업 · FileVault 재부팅 · 새 Mac 재현(bootstrap).

- 엔진(이 패키지)과 설정(`m3.toml` + 내 플러그인)은 별도 저장소로 분리
- vault(Bitwarden 등), backup(restic 등), 서비스 점검 방식은 플러그인으로 교체 · 추가 → [PLUGINS.md](PLUGINS.md)

## 설치

```sh
npm i -g my-mac-manager
m3 init ~/my-mac --host mini     # ~/my-mac/m3.toml 생성 (git 저장소로 관리 권장)
cd ~/my-mac && m3
```

요구 사항
- 관리하는 컴퓨터: Node 22 이상, `ssh` (대상 Mac 공개키 로그인). 사용하는 vault CLI (예: `bw`)
- 대상 Mac: macOS, 원격 로그인(SSH) 켜짐. 원격 코드는 `/usr/bin/python3`(Xcode CLT) · `sh` 만 사용

설정 파일 탐색: `--config` → `$M3_CONFIG` → 현재 · 상위 디렉토리의 `m3.toml` → `~/.config/m3/m3.toml`

## 명령

| 명령 | 용도 |
|---|---|
| `m3` / `m3 status [프로젝트]` | 상태 요약 / 상세 |
| `m3 logs <프로젝트> [-n 50]` | launchd · compose 로그 |
| `m3 start\|stop\|restart <프로젝트>` | 제어 (gui · system 도메인 자동 판별) |
| `m3 audit` | m3.toml 미등록 launchd · 컨테이너 · 포트 · 고아 프로세스 |
| `m3 reboot` / `m3 unlock` / `m3 wait` / `m3 login` | 계획 재부팅 (FileVault authrestart + 화면 공유 자동 로그인) / 정전 후 SSH FileVault 해제 / 복귀 대기 / GUI 로그인 |
| `m3 daemonize [프로젝트] [--rollback]` | `daemon = true` 프로젝트 → LaunchDaemon (GUI 로그인 없이 부팅 시 기동) |
| `m3 install` | 원격 스크립트 · 설정 · launchd plist 배포 및 로드 |
| `m3 host plan\|apply` | 호스트 설정 (pmset, SSH, 화면 공유, 자동 업데이트, 헬퍼 · sudoers) 점검 / 적용 |
| `m3 creds check\|push` | vault 항목 → 대상 Mac 백업 자격 |
| `m3 env [status\|push\|pull]` | `.env` 파일 ↔ vault 보안 메모 (값 출력 없이 키 이름 차이만) |
| `m3 backup [now\|snapshots\|verify\|log]` / `m3 restore ...` | 백업 / 복원 |
| `m3 bootstrap <ssh호스트> [--list] [--from N]` | 새 Mac 전체 재현 |
| `m3 plugin list\|new\|check` | 플러그인 목록 · 뼈대 생성 · 규격 검사 |

## m3.toml

```toml
plugins = ["./plugins/my-check.mjs"]   # 추가 플러그인 (테이블보다 위에 작성)

[remote]
id = "m3"                    # 대상 Mac 이름 공간: ~/.local/share/<id>, ~/.config/<id>, /usr/local/libexec/<id>-launchd
files = ["scripts/x.sh"]     # ~/.local/share/<id>/ 에 함께 배포할 파일

[host]
ssh = "mini"                 # 필수. ~/.ssh/config 호스트
hostname = "my-mac"          # m3 host apply 시 설정
vnc_host = "100.x.y.z"       # m3 login 접속 주소 (Tailscale IP 권장)
screen_sharing = "vnc://my-mac.local"
brewfile = "host/Brewfile"   # bootstrap: brew bundle
tools = "host/tools.sh"      # bootstrap: brew 밖 도구 설치
settings = "host/extra.sh"   # m3 host 추가 점검 (check / note / ok 함수)
launchd = ["launchd"]        # 배포할 plist 파일 · 디렉토리 (__HOME__, __DIR__ 치환)
secrets = ["~/.ssh/id_ed25519"]   # 백업 대상 비밀값
dirs = ["~/notes"]                # 백업 대상 디렉토리 (tar)
dirs_exclude = ["node_modules"]

[vault]
use = "bitwarden"
item = "m3 > my-mac"         # 백업 자격 · Mac 로그인 암호 항목
env_prefix = "m3 > my-mac env: "
login_password_field = "password"

[backup]
use = "restic"
required = ["RESTIC_REPOSITORY", "RESTIC_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
aliases = { "encrypt token" = "RESTIC_PASSWORD" }   # vault 필드 이름 → 키
schedule = { hour = 4, minute = 30 }

[audit]
root = "~/Dev"               # 이 아래 디렉토리 중 m3.toml 미참조 항목 표시

[bootstrap]
path = ["~/.local/bin"]      # 프로젝트 setup 실행 시 PATH 앞에 추가

[workspace]                  # 서비스 없는 repo
repos = [{ repo = "https://github.com/me/notes.git", clone = "~/Dev/notes" }]

[projects.web]
desc = "설명"
repo = "git@github.com:me/web.git"
clone = "~/Dev/web"
launchd = ["com.me.web"]           # 상주 (pid 확인)
launchd_jobs = ["com.me.web.cron"] # 주기 실행 (마지막 exit 0)
launchd_system = ["sh.brew.x"]     # 외부 설치 LaunchDaemon
daemon = true                      # LaunchDaemon 전환 대상
daemon_ready = "curl -sf localhost:8080/health"   # 전환 후 확인, 실패 시 자동 되돌림
requires = "test -f ~/ready"       # 전환 전 조건
compose = "cd ~/Dev/web && docker compose"
docker = ["web-app-1"]
ports = [8080]
apps = ["/Applications/X.app/Contents/MacOS/X"]
heartbeat = { file = "~/.web/runs.jsonl", max_minutes = 60 }
errors = [{ file = "~/Library/Logs/web.log", since = "com.me.web", match = "ERROR", ignore = ["harmless"] }, { docker = "web-app-1" }]
gui = true                         # GUI 로그인 세션 필요
secrets = ["~/Dev/web/.env"]
env = ["~/Dev/web/.env"]           # vault 보안 메모와 동기화
dirs = ["~/Dev/web/data"]
data_backup = "docker exec db pg_dumpall -U postgres"     # stdout 덤프
data_restore = "docker exec -i db psql -U postgres"       # stdin 복원
setup = ["cd ~/Dev/web && npm ci"]                        # bootstrap 시 실행 ($M3_DIR 사용 가능)

[ignore]                     # audit 제외
launchd = []
ports = []
port_cmds = []
docker_exited = []
orphan_cmds = []
```

## 개발

```sh
npm i
npm run build        # dist/m3.js (단일 번들), dist/plugin.js, dist/types
npm run typecheck
node dist/m3.js --config ../my-mac/m3.toml
```
