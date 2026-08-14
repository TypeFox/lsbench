#!/bin/bash

# DEMO recording script
# Run this to generate a new gif that is linked on the README
# Update lsbench.tape accordingly to match any API changes

# copy over assets
cp gallery.logo ../.integration/langium-minilogo/examples/gallery.logo
cp script.ts ../.integration/langium-minilogo/script.ts

# roll the tape
vhs lsbench.tape