SHELL := /bin/bash
PY := .venv/bin/python
PIP := .venv/bin/pip
PORT ?= 8000

.PHONY: setup serve open run stop test

setup:
	command -v python3 >/dev/null || { echo 'python3 introuvable'; exit 1; }
	[ -x $(PY) ] || python3 -m venv .venv
	$(PIP) install --upgrade pip >/dev/null
	[ -f server/requirements.txt ] && $(PIP) install -r server/requirements.txt || true
	[ -f requirements.txt ] && $(PIP) install -r requirements.txt || true

serve:
	# kill anything on PORT to avoid clashes
	if lsof -iTCP:$(PORT) -sTCP:LISTEN -n -P >/dev/null 2>&1; then \
		lsof -tiTCP:$(PORT) -sTCP:LISTEN | xargs -I{} kill -9 {} || true; \
	fi
	# start server (no --reload for stability)
	$(PY) -m uvicorn server.app:app --host 127.0.0.1 --port $(PORT) &
	# wait for health
	for i in {1..40}; do \
		curl -sSf http://127.0.0.1:$(PORT)/health >/dev/null 2>&1 && break || sleep 0.5; \
	done

open:
	open coach.html

run: setup serve open

launch:
	chmod +x Launch-Coach.command
	./Launch-Coach.command

stop:
	- lsof -tiTCP:$(PORT) -sTCP:LISTEN | xargs -I{} kill -9 {}

test:
	pytest -q
