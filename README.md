# Bot Moderasi Keanggotaan Telegram

Bot untuk menjaga keanggotaan channel dan grup Telegram. Berjalan gratis di **Vercel** dengan database **Supabase**. Semua diatur lewat tombol di chat pribadi bot, tanpa perlu coding.

## Fitur

| Fitur | Fungsi singkat |
|---|---|
| **Ban saat keluar** | Member keluar dari satu channel, otomatis diban di semua channel dan grup jaringanmu. |
| **Cek member pasif** | Member yang tidak berkomentar di postingan channel dalam batas waktu akan diban. Ada mode simulasi agar aman dicoba. |
| **Auto approve join** | Permintaan bergabung disetujui otomatis sesuai syarat profil (foto, bio, link) dan waktu yang kamu atur. |
| **Persetujuan aturan** *(opsional)* | Calon member menerima pesan aturan dari bot dan harus menekan tombol **Setuju** dulu. Teks dan tombol bebas kamu ubah. |
| **Wajib join chat lain** *(opsional)* | Calon member harus sudah bergabung ke 1 sampai 5 channel atau grup lain sebelum disetujui. |
| **Pesan ban** *(opsional)* | Orang yang diban menerima pesan pemberitahuan dari bot. Teks bebas kamu ubah, berbeda untuk tiap alasan ban. |
| **Alat admin** | Ban dan cabut ban lewat ID, whitelist, riwayat ban, impor dan sinkronisasi member. |

---

## Cara Pasang

Siapkan akun **Telegram**, **GitHub**, **Supabase**, dan **Vercel** (semuanya gratis).

**1. Buat bot.** Di Telegram buka **@BotFather**, kirim `/newbot`, lalu salin **token** bot.

**2. Ambil ID kamu.** Kirim `/start` ke **@userinfobot**, salin angka **Id**.

**3. Siapkan database.**
1. Di supabase.com buat **New project**.
2. Buka **SQL Editor > New query**, tempel seluruh isi `supabase/schema.sql`, klik **Run**.
3. Di **Project Settings > API** salin **Project URL** dan **service_role key** (rahasia).

**4. Unggah ke GitHub.** Ekstrak zip, buat repository **Private** baru, lalu unggah seluruh isinya.

**5. Deploy di Vercel.** Klik **Add New > Project**, pilih repository tadi, isi **Environment Variables** berikut, lalu **Deploy**.

| Nama | Isi |
|---|---|
| `BOT_TOKEN` | token dari BotFather |
| `ADMIN_IDS` | ID Telegram kamu (banyak admin: pisahkan koma) |
| `WEBHOOK_SECRET` | kata acak (huruf dan angka) |
| `SETUP_KEY` | kata acak lain, untuk membuka halaman setup |
| `CRON_SECRET` | kata acak lain, untuk pemeriksaan terjadwal |
| `SUPABASE_URL` | Project URL dari Supabase |
| `SUPABASE_SERVICE_KEY` | service_role key (awalan `eyJ`) atau secret key (awalan `sb_secret_`) |

**6. Hubungkan bot.** Buka alamat ini di browser:
`https://NAMA-PROYEK.vercel.app/api/setup?key=ISI_SETUP_KEY`
Jika muncul "Setup berhasil", kirim `/start` ke bot kamu.

> **Memperbarui dari versi lama?** Lihat bagian **Cara Memperbarui** di bawah.

---

## Cara Memperbarui

Setelah kode baru diunggah (push) ke GitHub:

1. **Tunggu Vercel selesai.** Buka Vercel > **Deployments**, tunggu deployment terbaru berstatus **Ready**. Jika berstatus Error, buka dan baca log build.
2. **Jalankan ulang `supabase/schema.sql`** di Supabase SQL Editor. Aman diulang dan tidak menghapus data. Wajib bila rilis baru menambah fitur, tidak masalah bila tidak ada perubahan.
3. **Buka halaman setup:** `https://NAMA-PROYEK.vercel.app/api/setup?key=ISI_SETUP_KEY`. Halaman ini memasang ulang webhook dan memeriksa database. Pastikan tertulis **Setup berhasil** dan **Database: siap**.
4. **Kirim `/status` ke bot** untuk memastikan semuanya sehat, lalu `/start`.

Bila kamu mengubah **Environment Variables** di Vercel, lakukan **Deployments > Redeploy** dulu, baru langkah 3.

---

## Cara Pakai

1. Jadikan bot **admin** di channel dan grup yang ingin dikelola. Chat akan muncul otomatis di panel (`/start`).
2. Untuk **cek member pasif**, jadikan bot admin juga di grup diskusi channel tersebut.
3. Masukkan akun penting (kamu, admin, mitra) ke **Whitelist**. Mereka tidak pernah diban otomatis.
4. Biarkan **Mode simulasi** menyala dulu. Bot hanya melapor siapa yang *akan* diban. Matikan setelah kamu yakin.

**Struktur menu** (`/start`):

| Kategori | Isi |
|---|---|
| **Auto Approve Join** | Persetujuan otomatis, syarat profil, aturan, wajib join, antrean |
| **Penegakan Member** | Chat Terkelola, Cek Member Pasif, Pesan Ban |
| **Moderasi Manual** | Ban Manual, Cabut Ban, Whitelist, Riwayat Ban |
| **Pengaturan** dan **Bantuan** | Mode simulasi, notifikasi, panduan |

Perintah: `/start` panel, `/status` kesehatan bot, `/cek` pemeriksaan pasif, `/ban ID`, `/unban ID`, `/whitelist ID`, `/help`.

---

## Pesan Ban (opsional)

Bot bisa memberi tahu orang yang diban lewat pesan pribadi, misalnya "kamu diban permanen dari 3 channel dan grup kami". Bawaannya **mati**.

**Cara mengatur:** `/start` > **Penegakan Member** > **Pesan Ban**. Nyalakan, lalu pilih jenisnya untuk **Ubah Teks**, **Reset Teks**, atau **Pratinjau** (pratinjau hanya dikirim ke kamu).

| Jenis pesan | Dikirim saat |
|---|---|
| Keluar dari Channel | member keluar sendiri |
| Member Pasif | member diban karena tidak berkomentar |
| Ban Manual | kamu memakai `/ban` atau tombol ban |

**Variabel teks** (boleh dipakai di mana saja):

| Tulis | Terisi dengan |
|---|---|
| `{nama}` | nama orang itu |
| `{jumlah}` | jumlah chat tempat ia berhasil diban |
| `{alasan}` | alasan singkat (keluar dari channel, tidak aktif berkomentar, dibanned oleh admin) |
| `{chat}` | channel atau grup asal |
| `{daftar}` | daftar nama chat tempat ia diban |

Contoh: `Halo {nama}. Kamu diban permanen dari {jumlah} chat karena {alasan}.`

**Yang perlu diketahui:**
- Telegram hanya mengizinkan bot mengirim pesan ke orang yang **pernah membuka bot**. Orang yang belum pernah membuka bot **tidak akan menerima pesan**. Ban tetap berjalan, dan hasilnya (terkirim atau gagal) tercatat di **Riwayat Ban** serta laporan admin.
- Pesan dikirim **sekali** setelah ban selesai. Satu orang tidak dikirimi lagi dalam 24 jam, jadi tombol **Ban Ulang** tidak membanjiri pesan.
- Tidak dikirim jika semua ban gagal. Admin dan whitelist tidak pernah diban, jadi tidak menerima pesan ini.

---

## Auto Approve Join

**Persiapan:** tautan undangan harus memakai opsi **Request Admin Approval** (atau chat publik dengan persetujuan admin), dan bot punya hak **Undang Pengguna**.

Buka `/start` > **Auto Approve Join** > pilih chat, lalu atur:

- **Syarat Profil:** wajib foto, wajib bio, aturan link di bio. Cocokkan *semua* atau *salah satu*.
- **Waktu Persetujuan:** langsung, atau dengan jeda 1 menit sampai 30 hari.
- **Notifikasi:** pesan "disetujui" ke member (`{nama}` dan `{chat}` bisa dipakai) dan peringatan ke admin.
- **Persetujuan Aturan** dan **Wajib Join** (di bawah).

Yang tidak memenuhi syarat **tidak ditolak**. Admin menerima pesan dengan tombol **Setujui** dan **Tolak**. Akun whitelist dan admin melewati semua syarat.

### Persetujuan aturan dan wajib join (opsional)

Keduanya bisa dipakai sendiri-sendiri atau digabung. Alurnya:

```
Orang meminta join
      ↓
Bot kirim pesan: aturan + tombol Setuju + tautan channel/grup wajib
      ↓
Orang menekan tombol  →  bot cek apakah sudah bergabung
      ↓
Lengkap → disetujui (mengikuti jeda yang diatur)
Belum   → bot tampilkan yang kurang, orang bisa menekan Cek Lagi
```

**Mengatur persetujuan aturan:** pilih chat > **Persetujuan Aturan**. Nyalakan, lalu **Ubah Teks** (maksimal 1000 karakter, boleh pakai `{nama}` dan `{chat}`) dan **Ubah Label Tombol** (misalnya "Saya Setuju dan Lanjut"). Tombol **Pratinjau** menampilkan hasilnya.

**Mengatur wajib join:** pilih chat > **Wajib Join**, ketuk channel atau grup yang diwajibkan (maksimal 5, ketuk lagi untuk menghapus), lalu nyalakan. Syaratnya, bot harus **admin** di chat yang diwajibkan agar bisa memeriksa anggota.

Hal yang perlu diketahui:
- Fitur ini berjalan di dalam **Auto Approve**, jadi Auto Approve chat itu harus aktif.
- Jika calon member tidak menyelesaikannya dalam 24 jam (bisa diubah lewat `GATE_TTL_MINUTES`), permintaan dipindah ke antrean manual. **Tidak ditolak otomatis.**
- Jika bot tidak bisa memverifikasi keanggotaan (misalnya hak admin kurang), permintaan masuk antrean manual dan admin diberi tahu. Bot tidak pernah menyetujui saat ragu.
- Calon member yang menghapus pesannya bisa mengirim `/start` ke bot untuk menerimanya lagi.

---

## Penjadwalan (cron)

Vercel gratis hanya menjalankan cron **sekali sehari** (08:00 WIB). Itu cukup untuk batas waktu dalam hitungan hari. Untuk lebih sering (jeda persetujuan dalam menit, atau cek tiap jam):

1. Daftar gratis di **cron-job.org**.
2. Buat cron tiap 1 menit ke `https://NAMA-PROYEK.vercel.app/api/join-cron?key=ISI_CRON_SECRET` (persetujuan bertunda).
3. Opsional, cron tiap jam ke `https://NAMA-PROYEK.vercel.app/api/cron?key=ISI_CRON_SECRET` (cek member pasif).

Persetujuan "Langsung" dan tombol di pesan syarat **tidak butuh cron**.

---

## Catatan Penting

- **Member lama tidak terlihat.** Telegram tidak membolehkan bot membaca daftar subscriber. Bot hanya melacak yang bergabung setelah aktif. Untuk cek member pasif, impor ID member lama lewat tombol **Impor Member**.
- **Pesan ke calon member.** Telegram hanya mengizinkan bot mengirim pesan ke orang yang belum pernah membuka bot selama **5 menit** setelah mereka meminta join. Pesan syarat dikirim seketika, jadi aman. Jika gagal terkirim, permintaan masuk antrean manual.
- **Privasi.** Foto dan bio yang disembunyikan terbaca kosong, sehingga orang itu masuk antrean manual. Bot tidak menyimpan isi bio.
- **Postingan terhapus tidak dihitung.** Jika keberadaan postingan tidak bisa dipastikan, tidak ada yang diban.
- Hanya **keluar atas kemauan sendiri** yang memicu ban. Member yang dikeluarkan admin tidak diban otomatis.
- **Salah ban?** Pakai `/unban ID` atau menu Penegakan Member > Cabut Ban.

Variabel opsional: `TIMEZONE` (bawaan `Asia/Jakarta`), `LOG_CHAT_ID` (chat untuk pengecekan postingan), `DM_ORDER` (`before` atau `after`), `GATE_TTL_MINUTES` (bawaan `1440`).

---

## Masalah Umum

| Masalah | Solusi |
|---|---|
| Bot tidak merespons `/start` | Buka `/api/setup?key=...` dan baca barisnya: **Galat webhook terakhir** (secret atau URL salah), **Update tertunda** (webhook belum menjawab), **Database** (skema belum diperbarui). Lalu kirim `/status` ke bot. Bila bot membalas "khusus untuk administrator", salin ID yang tampil ke `ADMIN_IDS`, lalu Redeploy. |
| Status menampilkan kode `42501` atau "permission denied" | Jalankan ulang seluruh `supabase/schema.sql` (bagian akhirnya berisi perintah GRANT untuk `service_role`). |
| Bot membalas "Bot mengalami gangguan" | Baca baris **Penyebab** dan **Solusi** di pesan itu. Paling sering: `schema.sql` belum dijalankan ulang atau `SUPABASE_SERVICE_KEY` salah. |
| Chat tidak muncul di panel | Pastikan bot dijadikan **admin**, bukan anggota biasa. |
| Muncul "Terjadi kesalahan" di tombol | Jalankan ulang seluruh `supabase/schema.sql`, lalu buka halaman setup lagi. |
| Pesan syarat tidak sampai ke calon member | Pastikan bot punya hak **Undang Pengguna** dan tautan undangan memakai persetujuan admin. |
| "Verifikasi gagal" saat wajib join | Jadikan bot **admin** di semua channel atau grup yang diwajibkan. |
| Pesan ban tidak sampai ke orang yang diban | Normal bila orang itu belum pernah membuka bot. Lihat statusnya di **Riwayat Ban**. |
| Ban saat keluar tidak jalan | Bot harus admin dengan hak blokir, dan fitur aktif di panel chat itu. |
| Komentar tidak terbaca | Bot harus admin di grup diskusi yang terhubung ke channel. |
| "Chat log tidak dapat dijangkau" | Kirim `/start` ke bot dari akun admin pertama. |
| Ubah variabel tidak berefek | Di Vercel buka **Deployments > Redeploy**. |

---

## Pengujian

`npm test` menjalankan 72 pengujian dengan database dan Telegram tiruan (Node 22 atau lebih baru).
