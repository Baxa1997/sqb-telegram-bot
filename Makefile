CURRENT_DIR=$(shell pwd)
# APP = repo/dir name, so the image path matches image.repository in Ucode-io/deployments
APP=$(shell basename ${CURRENT_DIR})

# Defaults; the CI (Ucode-io/ci-cd build.yml) overrides REGISTRY/PROJECT_NAME/TAG/ENV_TAG.
REGISTRY=ghcr.io
PROJECT_NAME=ucode-io
TAG=latest
ENV_TAG=latest
DOCKERFILE=Dockerfile

# The image holds no settings: the bot token, the secrets and the ucode key come from Vault at run
# time (secret/k8s/ucode-prod/<app> → /app/.env), as for the website.
build-image:
	docker build --rm -t ${REGISTRY}/${PROJECT_NAME}/${APP}:${TAG} . -f ${DOCKERFILE}
	docker tag ${REGISTRY}/${PROJECT_NAME}/${APP}:${TAG} ${REGISTRY}/${PROJECT_NAME}/${APP}:${ENV_TAG}

push-image:
	docker push ${REGISTRY}/${PROJECT_NAME}/${APP}:${TAG}
	docker push ${REGISTRY}/${PROJECT_NAME}/${APP}:${ENV_TAG}

clear-image:
	docker rmi ${REGISTRY}/${PROJECT_NAME}/${APP}:${TAG}
	docker rmi ${REGISTRY}/${PROJECT_NAME}/${APP}:${ENV_TAG}

.PHONY: build-image push-image clear-image
