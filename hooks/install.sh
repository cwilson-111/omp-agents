#!/usr/bin/env bash
# Install the usage-budget hook and, optionally, the resume job.
#
#   ./hooks/install.sh                      # hook only
#   ./hooks/install.sh --resume <project>   # hook + a launchd job that
#                                           # resumes <project> from HANDOFF.md
#
# The hook is symlinked, not copied, so `git pull` updates it in place.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
HOOK_DIR="$AGENT_DIR/hooks/pre"
CONFIG="$AGENT_DIR/usage-budget.json"

mkdir -p "$HOOK_DIR"
ln -sfn "$HERE/pre/usage-budget.ts" "$HOOK_DIR/usage-budget.ts"
echo "hook      -> $HOOK_DIR/usage-budget.ts"

# Never overwrite a budget the user has already tuned.
if [ -f "$CONFIG" ]; then
	echo "config    -> $CONFIG (left alone)"
else
	cat >"$CONFIG" <<'JSON'
{
  "windowHours": 5,
  "budgetUsd": 60,
  "warnAt": 0.8,
  "stopAt": 0.99,
  "handoffPath": "HANDOFF.md"
}
JSON
	echo "config    -> $CONFIG (PLACEHOLDER — set budgetUsd to your real ceiling)"
fi

if [ "${1:-}" != "--resume" ]; then
	echo
	echo "Run /budget in a session to see where you stand."
	echo "Add the resume job with: $0 --resume /path/to/project"
	exit 0
fi

PROJECT="${2:?--resume needs a project directory}"
PROJECT="$(cd "$PROJECT" && pwd)"
OMP="$(command -v omp || echo "$HOME/.local/bin/omp")"
LABEL="sh.omp.resume$(echo "$PROJECT" | tr -c 'a-zA-Z0-9' '.')"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$AGENT_DIR/resume-logs"
mkdir -p "$LOG_DIR"

# Hourly, not a fixed clock time. The budget is a ROLLING window, so there is
# no moment it "resets": room reappears gradually as old spend ages out. A
# fixed 07:00 run would either fire while still over budget or sit idle for
# hours after room came back. Hourly runs are cheap because each one bails
# out immediately unless there is both unfinished work and room to do it —
# and the usage-budget hook loads in this session too, so even a run that
# ignores the prompt is still halted at the stop threshold.
cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>WorkingDirectory</key><string>$PROJECT</string>
	<key>ProgramArguments</key>
	<array>
		<string>$OMP</string>
		<string>-p</string>
		<string>Resume from HANDOFF.md. First run /budget. If spend is at or above the warn threshold it reports, stop immediately and say so. If HANDOFF.md is missing, or its "In progress" section has no next action, stop and say so. Otherwise carry out only the stated next action, verify it the way the file says finished work was verified, then refresh HANDOFF.md.</string>
	</array>
	<key>StartInterval</key><integer>3600</integer>
	<key>StandardOutPath</key><string>$LOG_DIR/$LABEL.out.log</string>
	<key>StandardErrorPath</key><string>$LOG_DIR/$LABEL.err.log</string>
	<key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "resume    -> $PLIST (hourly; acts only with room and unfinished work)"
echo "logs      -> $LOG_DIR/$LABEL.{out,err}.log"
echo
echo "Remove with: launchctl unload '$PLIST' && rm '$PLIST'"
