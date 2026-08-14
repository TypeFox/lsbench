# lsbench.tape — VHS demo of lsbench benchmarking a real Langium (minilogo) server
#
# Render:   cd demo && vhs lsbench.tape
# Requires: vhs (brew install vhs), lsbench on PATH, and a built minilogo
#           server at ../.integration/langium-minilogo (./out present).
#
# script.ts in this folder is the action driver, kept here for reference.
# Produces lsbench.gif in this folder.

Output lsbench.gif

# terminal look & feel
Set Shell "zsh"
Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

# hop into the built minilogo workspace (hidden — keeps the frame clean)
Hide
Type "cd ../.integration/langium-minilogo"
Enter
Type "clear"
Enter
Show
Sleep 500ms

# show the command being typed out, line by line for readability
# (single-quoted Type string so the embedded double-quotes reach the shell verbatim)
Type `lsbench "node ./out/language-server/main.js --stdio" \`
Enter
Type "    --workspace ./examples \"
Enter
Type "    --script ./script.ts \"
Enter
Type "    --iterations 50 \"
Enter
Type "    --output ./results.json"
Sleep 1s
Enter

# let the benchmark run to completion and linger on the results table
Sleep 8s

# peek at the generated report
Type "cat results.json | head -n 20"
Sleep 500ms
Enter
Sleep 4s
