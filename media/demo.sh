#!/usr/bin/env bash
# Scripted demo for beflow watch — drives the VHS tape

BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
GREEN='\033[32m'
YELLOW='\033[33m'
CYAN='\033[36m'
BLUE='\033[34m'
GRAY='\033[90m'
WHITE='\033[97m'

printf "\n"
printf "  ${BOLD}beflow${RESET}  ${DIM}v0.1.0${RESET}  •  ${CYAN}APP${RESET}  •  poll 30s  •  wip-limit 2 in-review\n"
printf "\n"
sleep 0.6

printf "${GRAY}[09:14:01]${RESET} scanning queue…\n"
sleep 0.8
printf "           Todo ${YELLOW}▸ 2${RESET}   In Review ${CYAN}▸ 1${RESET}\n"
printf "\n"
sleep 0.5

printf "${GRAY}[09:14:02]${RESET} ${YELLOW}→${RESET} ${BOLD}APP-23${RESET}  Add rate-limit middleware\n"
sleep 0.2
printf "           repo: ${CYAN}api${RESET}   job: ${BLUE}implement${RESET}   mode: auto\n"
printf "\n"
sleep 0.4

printf "  ${DIM}worktree   /tmp/beflow/APP-23-a1b2c3${RESET}\n"
sleep 0.2
printf "  ${DIM}spawning   acpx --dangerously-skip-permissions …${RESET}\n"
printf "\n"
sleep 0.8

printf "  ${DIM}[  3s] agent running…${RESET}\n"
sleep 1.2
printf "  ${DIM}[ 18s] agent running…${RESET}\n"
sleep 1.2
printf "  ${DIM}[ 36s] agent running…${RESET}\n"
sleep 1.2
printf "  ${DIM}[ 57s] agent running…${RESET}\n"
sleep 1.2
printf "  ${DIM}[ 74s] agent running…${RESET}\n"
sleep 1.2
printf "  ${DIM}[ 91s] done${RESET}\n"
printf "\n"
sleep 0.4

printf "${GRAY}[09:15:33]${RESET} ${GREEN}✔${RESET}  ${BOLD}APP-23${RESET}  PR opened\n"
sleep 0.2
printf "            ${DIM}github.com/your-org/api/pull/47${RESET}\n"
sleep 0.2
printf "            state: ${YELLOW}Todo${RESET}  →  ${CYAN}In Review${RESET}\n"
printf "\n"
sleep 0.9

printf "${GRAY}[09:15:33]${RESET} scanning queue…\n"
sleep 0.8
printf "           Todo ${YELLOW}▸ 1${RESET}   In Review ${CYAN}▸ 2${RESET}  ${DIM}(limit: 2)${RESET}\n"
printf "\n"
sleep 0.4

printf "${GRAY}[09:15:34]${RESET} ${DIM}⏸  APP-24  holding — In Review WIP limit reached (2/2)${RESET}\n"
printf "\n"
sleep 1.8

printf "${GRAY}[09:16:04]${RESET} scanning queue…\n"
sleep 0.7
printf "           Todo ${YELLOW}▸ 1${RESET}   In Review ${CYAN}▸ 2${RESET}  ${DIM}(limit: 2)${RESET}\n"
printf "\n"
printf "${GRAY}[09:16:34]${RESET} ${DIM}next scan in 30s…${RESET}\n"
sleep 2
