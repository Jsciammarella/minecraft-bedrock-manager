# Security policy

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Contact the repository owner privately through the GitLab instance and include the affected version, reproduction steps, impact, and any suggested mitigation.

## Deployment warning

The manager does not currently implement authentication or authorization. Deploy it only on a trusted network or behind an authenticated reverse proxy with TLS. Restrict the management port and Bedrock UDP ports at the firewall, protect the data volume and `.env`, and keep the host, Node.js runtime, container base images, and dependencies updated.

Catalog API keys and Git tokens saved in the UI are stored in the SQLite database. Treat that database as a secrets store.

Never upload untrusted add-on archives without reviewing them first. Back up server data before upgrades or migrations.
