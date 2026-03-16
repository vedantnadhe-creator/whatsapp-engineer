#!/bin/bash
echo "=== Claude Test ==="
echo "Running claude -p 'say hello' --dangerously-skip-permissions --output-format text"
timeout 30 /home/ubuntu/.local/bin/claude -p "say hello" --dangerously-skip-permissions --output-format text > /tmp/claude_out.txt 2> /tmp/claude_err.txt
EXIT=$?
echo "EXIT_CODE=$EXIT"
echo "=== STDOUT ==="
cat /tmp/claude_out.txt
echo "=== STDERR ==="
cat /tmp/claude_err.txt
echo "=== DONE ==="
