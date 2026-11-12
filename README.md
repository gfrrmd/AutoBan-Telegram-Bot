# Bot Moderasi Keanggotaan Telegram

Bot Telegram untuk menegakkan aturan keanggotaan lintas channel dan grup. Berjalan di Vercel dengan database Supabase.

## Fitur

**1. Ban saat keluar**
Jika seseorang keluar dari salah satu channel yang diaktifkan, bot otomatis memban permanen orang itu di semua chat dalam jaringan ban (misalnya keluar dari Channel A, maka diban di A, B, dan C).

**2. Cek member pasif**
Member wajib berkomentar di setiap postingan channel (lewat grup diskusi) dalam batas waktu yang bisa diatur bebas. Jika tidak, member diban dari semua chat dalam jaringan.
- Postingan yang sudah dihapus tidak pernah dihitung. Bot memverifikasi keberadaan postingan sebelum menghitung dan sebelum memban.
- Jika keberadaan postingan tidak bisa dipastikan, bot memilih aman: tidak ada yang diban.
- Mode simulasi aktif secara bawaan: bot hanya melaporkan siapa yang akan diban.

**Panel admin** lewat tombol di chat pribadi bot: chat terkelola, batas waktu, toleransi, whitelist, riwayat ban, cabut ban, impor member.

---

## Panduan Deploy untuk Pemula

Siapkan: akun Telegram, akun GitHub (gratis), akun Supabase (gratis), akun Vercel (gratis, login pakai GitHub).

### Langkah 1. Buat bot di Telegram
1. Buka Telegram, cari **@BotFather**, kirim `/newbot`.
2. Ikuti instruksi nama dan username bot.
3. Salin **token** yang diberikan (bentuknya `123456:ABC...`). Simpan, ini rahasia.

### Langkah 2. Ambil ID Telegram kamu
1. Cari **@userinfobot** di Telegram, kirim `/start`.
2. Salin angka **Id** kamu. Ini dipakai sebagai admin bot.

### Langkah 3. Siapkan database (Supabase)
1. Buka supabase.com, login, klik **New project**. Isi nama dan password, pilih region terdekat (Singapore), tunggu selesai.
2. Di menu kiri buka **SQL Editor**, klik **New query**.
3. Buka file `supabase/schema.sql` dari proyek ini, salin seluruh isinya, tempel, lalu klik **Run**. Pesan "Success" berarti tabel sudah dibuat.
4. Buka **Project Settings > API**. Salin dua hal:
   - **Project URL**
   - **service_role** key (bagian "Project API keys", klik Reveal). Ini rahasia, jangan dibagikan.

### Langkah 4. Unggah kode ke GitHub
1. Ekstrak file zip ini di HP/komputer sampai terlihat folder `api`, `lib`, dan lainnya.
2. Buka github.com, klik **New repository**, beri nama (misal `bot-moderasi`), pilih **Private**, klik **Create repository**.
3. Klik **uploading an existing file**, unggah seluruh isi hasil ekstrak (folder `api`, `lib`, `supabase`, serta file `package.json`, `vercel.json`, dll.), lalu klik **Commit changes**.

### Langkah 5. Deploy di Vercel
1. Buka vercel.com, klik **Add New > Project**, pilih repository `bot-moderasi`, klik **Import**.
2. Buka bagian **Environment Variables**, tambahkan satu per satu:

| Nama | Isi |
|---|---|
| `BOT_TOKEN` | token dari BotFather |
| `ADMIN_IDS` | ID Telegram kamu (beberapa admin: pisahkan koma) |
| `WEBHOOK_SECRET` | kata acak, huruf/angka saja, contoh `rahasia8821xyz` |
| `SETUP_KEY` | kata acak lain untuk membuka halaman setup |
| `CRON_SECRET` | kata acak lain untuk pemeriksaan terjadwal |
| `SUPABASE_URL` | Project URL dari Supabase |
| `SUPABASE_SERVICE_KEY` | service_role key dari Supabase |

3. Klik **Deploy**, tunggu sampai muncul tampilan selamat.

### Langkah 6. Hubungkan bot ke Vercel
Buka alamat ini di browser (ganti nilai sesuai milikmu):

`https://NAMA-PROYEK.vercel.app/api/setup?key=ISI_SETUP_KEY`

Jika muncul "Setup berhasil", bot sudah aktif. Buka bot di Telegram dan kirim `/start`.

### Langkah 7. Tambahkan bot ke channel dan grup
1. Jadikan bot **admin** di setiap channel yang ingin dipantau. Berikan hak admin yang tersedia (blokir pengguna/tambah subscriber, hapus pesan). Jika ragu, aktifkan semua kecuali "Tambah Admin Baru".
2. Untuk cek member pasif: jadikan bot **admin juga di grup diskusi** channel tersebut (grup yang terhubung sebagai kolom komentar).
3. Chat yang kamu tambahkan sendiri akan langsung muncul di **Chat Terkelola** dan masuk jaringan ban.

### Langkah 8. Atur lewat panel
1. `/start` lalu **Chat Terkelola**, pilih channel.
2. **Ban saat keluar**: aktif secara bawaan.
3. **Cek member pasif**: aktifkan, lalu atur **Batas Waktu** dan **Toleransi**.
4. **Impor Member**: kirim daftar ID member lama (lihat catatan di bawah).
5. Biarkan **Mode simulasi** aktif dulu (menu Pengaturan). Jalankan **Cek Member Pasif > Jalankan Pemeriksaan Sekarang** dan baca laporannya. Jika sudah yakin, matikan mode simulasi agar ban benar-benar dijalankan.
6. Masukkan akun penting (diri sendiri, admin, mitra) ke **Whitelist**.

---

## Penjadwalan pemeriksaan

Vercel paket gratis (Hobby) hanya mengizinkan cron **sekali sehari**. Bawaan proyek ini berjalan setiap hari pukul 08:00 WIB. Cukup untuk batas waktu dalam hitungan hari.

Untuk pemeriksaan lebih sering (misal tiap jam, untuk batas waktu 12 jam):
1. Daftar gratis di cron-job.org.
2. Buat cron baru dengan alamat `https://NAMA-PROYEK.vercel.app/api/cron?key=ISI_CRON_SECRET`, jadwal tiap jam.

## Catatan penting

- **Member lama tidak terlihat.** Telegram tidak mengizinkan bot membaca daftar subscriber channel. Bot hanya melacak orang yang bergabung setelah bot aktif. Member lama harus diimpor lewat tombol **Impor Member** (daftar ID, misalnya hasil ekspor dari akun/userbot kamu). Tanpa impor, member lama tidak akan dicek, tetapi tetap diban jika keluar.
- **Cara kerja per postingan.** Tiap postingan punya batas waktu sendiri. Setelah lewat, member yang sudah bergabung sebelum postingan terbit dan belum berkomentar dihitung terlewat. Member diban jika jumlah postingan terlewat mencapai **Toleransi**.
- **Deteksi postingan terhapus.** Telegram tidak mengirim notifikasi saat pesan dihapus, jadi bot memeriksa langsung ke channel saat jatuh tempo (menyalin sekejap ke chat admin lalu menghapusnya). Pastikan admin pertama di `ADMIN_IDS` sudah menekan `/start` di bot. Opsional: isi `LOG_CHAT_ID` dengan ID grup privat khusus.
- Channel dengan fitur "Restrict Saving Content" bisa membuat verifikasi tidak pasti. Hasilnya tetap aman: postingan dilewati dan tidak ada yang diban.
- Hanya keluar atas kemauan sendiri yang memicu ban. Member yang dikeluarkan admin tidak diban otomatis.
- Admin channel, admin bot, dan whitelist tidak pernah diban otomatis.
- Salah ban? Gunakan `/unban ID` atau menu Riwayat Ban > Cabut Ban.

## Pemecahan masalah

| Masalah | Solusi |
|---|---|
| Bot tidak merespons `/start` | Buka lagi halaman `/api/setup?key=...`, pastikan ID kamu ada di `ADMIN_IDS` |
| Chat tidak muncul di panel | Pastikan bot dijadikan **admin**, bukan anggota biasa |
| Ban saat keluar tidak jalan | Pastikan bot admin di channel dengan hak blokir/tambah subscriber, dan fitur aktif di panel |
| Komentar tidak terbaca | Bot harus admin di grup diskusi, dan grup itu harus terhubung ke channel |
| Laporan "Chat log tidak dapat dijangkau" | Kirim `/start` ke bot dari akun admin pertama |
| Gagal ban di sebuah chat | Hak admin bot kurang, periksa laporan notifikasi |
| Setelah ubah variabel tidak berefek | Di Vercel buka **Deployments > Redeploy** |
