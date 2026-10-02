export const PCMSD_USER_SERVICE = `[Unit]
Description=PCMS Local control plane
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=%h/.local/lib/pcms-local/current/bin/pcmsd
WorkingDirectory=%h/.local/lib/pcms-local/current
EnvironmentFile=-%h/.config/pcms-local/pcmsd.env
UMask=0077
Restart=on-failure
RestartSec=2s
TimeoutStopSec=15s
KillSignal=SIGTERM
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;

export const PCMSD_USER_SERVICE_INSTALL_PATH =
  "~/.config/systemd/user/pcmsd.service";
