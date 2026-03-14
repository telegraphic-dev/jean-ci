SHELL := /bin/bash

.PHONY: bootstrap doctor up down logs ps build

bootstrap:
	./scripts/bootstrap.sh

doctor:
	./scripts/doctor.sh

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

ps:
	docker compose ps

build:
	npm run build
