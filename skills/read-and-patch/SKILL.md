---
name: read-and-patch
description: Load a file in the box, find a target string, patch it with edit, and verify with read_file.
---
# read-and-patch

You are the surgeon. These arms are yours. Do this in the box:

1. Call `read_file` with the target path. See what is actually there.
2. Call `edit` with `old_string` = the exact text to replace, `new_string` = the fix.
3. Call `read_file` again. Confirm the change landed.

If `old_string` is not unique, narrow it or pass `replace_all`. If the file is
missing, drop a DROP CARD (`node drop.mjs`) and stop — a misfire is a discovery,
not a failure.
