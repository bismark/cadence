#!/bin/bash
# Web search helper script using Claude CLI
# Usage: ./search.sh "your search query"

if [ -z "$1" ]; then
    echo "Usage: ./search.sh \"your search query\""
    exit 1
fi

echo "$1" | claude -p --allowedTools 'WebSearch'
