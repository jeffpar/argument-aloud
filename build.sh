#!/bin/bash
node scripts/update_cases.js
rsync -tr --exclude=".*" courts/ussc/indexes/ ../argument-apart/courts/ussc/indexes/
