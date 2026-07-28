FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create an isolated Python environment (the PEP 668-correct way).
# pip fully owns this env, so `pip install` works with no flags.
RUN python3 -m venv /opt/venv

# Put the venv first on PATH so `python3` and `pip` resolve to it automatically.
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /workspace

CMD ["bash"]