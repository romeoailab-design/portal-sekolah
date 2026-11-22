# Panduan Deploy Portal Sekolah: Lokal → GitHub → cPanel DomaiNesia

Aplikasi ini berjalan **100% mandiri** menggunakan **Node.js + Express + MySQL + Disk Storage (`uploads/`) + Google OAuth 2.0**, tanpa ketergantungan Firebase Cloud.

---

## 1. Menjalankan & Maintenance di Komputer Lokal (Laragon)

1. Pastikan **Laragon** menyala (`Start All`) dan database `portal_sekolah` sudah dibuat.
2. Salin `.env.example` menjadi `.env` lalu lengkapi minimal:
   ```env
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=portal_sekolah
   JWT_SECRET=isi_kode_acak_panjang_minimal_32_karakter
   VITE_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   ```
3. Jalankan mode pengembangan:
   ```bash
   npm run dev
   ```
   Buka `http://localhost:3000`.
4. Uji mode produksi lokal sebelum push ke GitHub:
   ```bash
   npm run build
   NODE_ENV=production npm start
   ```

---

## 2. Export Database Lokal untuk Pertama Kali ke DomaiNesia

Karena data lama sudah dipindahkan ke MySQL lokal `portal_sekolah`:
1. Buka **HeidiSQL** di Laragon → klik kanan database `portal_sekolah` → **Export database as SQL**.
2. Centang **Create** pada Tables, dan pilih Data: **Insert** → simpan sebagai `portal_sekolah.sql`.
3. Di **cPanel DomaiNesia**:
   - Buka **MySQL® Database Wizard**: buat database baru, buat user + password, centang **ALL PRIVILEGES**.
   - Buka **phpMyAdmin** → pilih database baru tersebut → tab **Import** → pilih file `portal_sekolah.sql` → **Go**.

---

## 3. Setup Node.js App di cPanel DomaiNesia

1. Login cPanel DomaiNesia → buka menu **Setup Node.js App** → klik **Create Application**:
   - **Node.js version**: `22.x` (atau `20.x` / `24.x`)
   - **Application mode**: `Production`
   - **Application root**: `portal-sekolah`
   - **Application URL**: pilih domain Anda (contoh: `portal.namasekolah.sch.id`)
   - **Application startup file**: `dist/server.cjs`
2. Tambahkan **Environment Variables** di halaman aplikasi Node.js tersebut:
   - `NODE_ENV` = `production`
   - `DB_HOST` = `localhost`
   - `DB_PORT` = `3306`
   - `DB_NAME` = *(nama database cPanel, misal `u123456_portalsekolah`)*
   - `DB_USER` = *(user database cPanel)*
   - `DB_PASSWORD` = *(password database cPanel)*
   - `JWT_SECRET` = *(kode acak panjang 32+ karakter)*
   - `VITE_GOOGLE_CLIENT_ID` = *(Google OAuth Client ID Anda)*
   - `GOOGLE_CLIENT_ID` = *(sama dengan di atas)*
   - `VITE_CORE_DOMAINS` = *(domain utama Anda, misal `portal.namasekolah.sch.id`)*
   - `GEMINI_API_KEY` = *(opsional)*
   - `FONNTE_TOKEN` = *(opsional)*
   - `FONNTE_GROUP_ID` = *(opsional)*
3. Jangan lupa tambahkan `https://domain-anda.sch.id` ke **Google Cloud Console → Credentials → OAuth Client ID → Authorized JavaScript origins** dan ubah status OAuth Consent Screen menjadi **Publish App** agar semua guru/siswa bisa login.

---

## 4. Alur Update Rutin via GitHub → DomaiNesia

### Cara Paling Aman (Build di Lokal / GitHub → Pull di cPanel)
Shared hosting kadang memiliki batas RAM untuk build Vite. Oleh karena itu:

1. **Di komputer lokal:**
   - Edit & tes aplikasi sampai beres (`npm run dev`).
   - Build produksi:
     ```bash
     npm run build
     ```
   - Push kode ke repository **Private GitHub** Anda (`git add . && git commit -m "update fitur" && git push`).
   - *(Opsional untuk cPanel Git™ Version Control tanpa build di server)*: Anda bisa membuat branch khusus `deploy` yang ikut menyertakan folder `dist/` (`git add -f dist`), lalu arahkan menu **Git™ Version Control** di cPanel ke branch `deploy` — file `.cpanel.yml` akan otomatis menyalin `dist/` + `package.json` ke folder `portal-sekolah` dan me-restart Passenger tanpa menyentuh folder `uploads/`!
2. **Di cPanel DomaiNesia:**
   - Buka **Git™ Version Control** → **Manage** → tab **Pull or Deploy** → klik **Update from Remote**, lalu **Deploy HEAD Commit**.
   - Jika ada perubahan paket di `package.json`, buka **Setup Node.js App** → klik **Run NPM Install** → klik **Restart**.
