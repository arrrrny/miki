---
name: submit-exercise
description: Run a graded gym exercise in the box, verify output, and submit the result.
---
# submit-exercise

A graded rep for the GYM. Steps:

1. Read the exercise spec the coach handed you (a file in the box, or via `skills` get).
2. Drive the arms (read_file / write_file / exec / edit / multiedit) to complete it.
3. Run the verify command from the spec with `exec`.
4. If it passes: report the result back to the coach.
   If it misfires: drop a DROP CARD (`node drop.mjs`) describing what you did,
   what you expected, and what happened — then stop.
