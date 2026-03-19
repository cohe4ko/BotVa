# Orange Pi Lite Listener -- Quick Start

## Крок 1: Прошивка SD-картки

Armbian вже скачано: `workspace/cap/orange-pi/armbian-opi-lite.img.xz`

```bash
# Знайди диск (вставлену SD-картку)
diskutil list external physical

# Прошити (замінити diskN!)
sudo bash scripts/orange-pi-listener/flash-sd.sh /dev/diskN
```

Або вручну через [Balena Etcher](https://etcher.balena.io/):
1. Відкрий Etcher
2. Select image: `workspace/cap/orange-pi/armbian-opi-lite.img.xz`
3. Select drive: SD-картка
4. Flash!
5. Після flash, скопіюй `armbian_first_run.txt` в `/boot/` на SD-картці

## Крок 2: Boot

1. Встав SD в Orange Pi Lite
2. Підключи живлення (micro USB, 5V 2A)
3. Зачекай 2-3 хв
4. WiFi: M8 (підключиться автоматично)
5. SSH: `root@<IP>`, пароль: `listener2026`

## Крок 3: Скажи cap

> "Orange Pi online, IP: xxx.xxx.xxx.xxx -- налаштуй listener"

Cap по SSH:
- Встановить пакети
- Налаштує мікрофон
- Скопіює listener.py + config.env
- Створить systemd сервіс
- Запустить

## Промпт для cap (SSH setup)

```
Orange Pi Lite підключений до мережі, IP: <IP>.
SSH: root@<IP>, пароль: listener2026

Зайди по SSH і налаштуй room listener:
1. apt install python3 python3-pip python3-venv alsa-utils
2. Налаштуй мікрофон (sun4i codec): amixer Mic1 cap 80%, Mic1 Boost 60%
3. Скопіюй listener.py і config.env з scripts/orange-pi-listener/ на /opt/listener/
4. В config.env: UPLOAD_URL=http://<BOTVA_IP>:3847/audio, DEVICE_ID=opi-1
5. Створи venv, pip install requests
6. Створи systemd service, enable + start
7. Перевір що працює: journalctl -u listener
```
