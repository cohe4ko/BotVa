# Orange Pi Lite Listener — Flash & Setup

## 1. Завантаж Armbian

Armbian Bookworm CLI для Orange Pi Lite:
https://www.armbian.com/orange-pi-lite/

Вибирай **CLI** (без desktop), **Bookworm** або **Jammy**.

## 2. Прошивка на microSD

### macOS (Balena Etcher)
1. Завантаж [Balena Etcher](https://etcher.balena.io/)
2. Встав microSD (мін. 8 GB)
3. Flash -> Select image -> Select drive -> Flash!

### macOS (dd)
```bash
# Знайди диск
diskutil list
# Unmount (замінити diskN на правильний!)
diskutil unmountDisk /dev/diskN
# Flash (ОБЕРЕЖНО з номером диска!)
sudo dd if=Armbian_*.img of=/dev/rdiskN bs=4m status=progress
```

## 3. Підготовка config

```bash
cd scripts/orange-pi-listener/
cp config.env.example config.env
# Заповни: WiFi, Groq API ключ, upload URL
nano config.env
```

## 4. Копіювання файлів на SD-карту

Після прошивки Armbian, SD-карта матиме розділ з файловою системою.
Скопіюй скрипти:

```bash
# Монтуй SD карту
# Знайди розділ (зазвичай другий)
mkdir -p /tmp/sdcard
sudo mount /dev/diskNs2 /tmp/sdcard  # або /dev/diskNp2

# Копіюй скрипти
sudo mkdir -p /tmp/sdcard/root/listener-setup
sudo cp config.env listener.py setup.sh /tmp/sdcard/root/listener-setup/

sudo umount /tmp/sdcard
```

## 5. Перший запуск Orange Pi

1. Встав microSD в Orange Pi Lite
2. Підключи живлення (micro USB, 5V 2A)
3. Зачекай 1-2 хв (перший boot довший)
4. Знайди IP: перевір роутер або `arp -a | grep -i orange`
5. SSH: `ssh root@IP_ADDRESS` (пароль: 1234, змінить при першому вході)

## 6. Запуск setup

```bash
cd ~/listener-setup
chmod +x setup.sh
sudo bash setup.sh
```

Скрипт:
- Встановить залежності (alsa, python3, pip)
- Налаштує WiFi
- Налаштує мікрофон
- Створить systemd сервіс
- Увімкне автозапуск

## 7. Перевірка

```bash
# Запуск
sudo systemctl start listener

# Логи в реальному часі
journalctl -u listener -f

# Перевірка транскриптів
ls -la /data/transcripts/
```

## Troubleshooting

### Мікрофон не працює
```bash
# Список пристроїв
arecord -l
# Тест запису
arecord -D plughw:0,0 -f S16_LE -r 16000 -c 1 -d 5 /tmp/test.wav
# Перевірка рівнів
alsamixer
```

### WiFi не підключається
```bash
nmcli dev wifi list
nmcli dev wifi connect "SSID" password "PASSWORD"
```

### API помилки
```bash
# Перевірити Groq ключ
curl -s https://api.groq.com/openai/v1/models \
  -H "Authorization: Bearer $GROQ_API_KEY" | jq .
```
