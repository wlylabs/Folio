# Artikel X (Twitter) — Folio

Naskah siap tempel untuk fitur **Articles** di X. Ada dua versi lengkap —
Bahasa Indonesia dan English — plus post pengantar untuk menautkan artikelnya.

Cara pakai: salin blok di antara garis `====` (judul, subjudul, isi) langsung ke
editor Articles. Naskahnya sengaja tidak memakai simbol markdown (`##`, `**`),
karena editor X menempelkannya apa adanya. Judul bagian ditulis di barisnya
sendiri — tinggal blok teksnya lalu pilih *Heading* di toolbar.

Satu hal yang harus diisi sebelum posting: setiap `[URL FOLIO]` diganti alamat
situsnya. Angka-angka di naskah diambil dari repositori ini — factory
`0xcCdE95C857561E16E14d37f235E8cb5F5cd35469` di Robinhood Chain (4663), fee 100
bps, virtual reserve 5 ETH, opening window 120 detik dengan batas 0,25 ETH per
wallet — jadi kalau parameter itu berubah, naskah ini ikut berubah.

---

## Versi Bahasa Indonesia

====================================================================

Kalau Halaman Listing-nya Adalah Artikelnya

Folio adalah launchpad tempat token diterbitkan sebagai tulisan — dan tulisan itu tidak bisa diedit setelah orang membelinya.

Setiap launchpad memberi Anda kolom deskripsi. Dua ratus karakter di bawah sebuah ticker, biasanya diisi tiga emoji dan satu janji. Lalu orang mengirim uang ke sana.

Folio membalik urutannya. Yang Anda tulis adalah artikelnya: judul, byline, isi tulisan yang menjelaskan kenapa benda ini ada. Tokennya lahir dari halaman yang sama, dan panel jual-belinya ada di kaki artikel — bukan di atasnya. Argumennya dibaca dulu, tombolnya belakangan.

Yang membuat itu lebih dari sekadar keputusan tata letak adalah apa yang terjadi setelah tombolnya ditekan.

Satu transaksi, satu pasar

Menerbitkan launch memanggil satu fungsi di kontrak factory. Factory itu meng-clone sebuah ERC20 yang sekaligus menjadi market maker-nya sendiri — kurva bonding constant product, x * y = k, dengan virtual reserve yang memberi kurvanya harga pembuka yang terhingga.

Tidak ada pool yang perlu diisi. Tidak ada counterparty yang perlu dicari. Tidak ada biaya listing. Pembeli membeli dari kurva, penjual menjual balik ke cadangan yang dipegang kurva itu, dan setiap harga yang muncul di artikel dikutip oleh kontraknya saat itu juga — bukan diambil dari cache pasar di tempat lain.

Karena tiap launch adalah minimal proxy di atas satu implementasi bersama, ongkos membuatnya sekitar 41 ribu gas, bukan 1,5 juta. Bagi penulisnya, sebuah launch tidak memakan biaya apa pun selain gas.

Cadangannya selalu cukup — dan itu bisa dihitung

Ini bagian yang paling sering dijanjikan dan paling jarang dibuktikan, jadi ini angkanya.

Membeli balik seluruh token yang beredar dari kurva berharga persis sebesar cadangan ETH yang dipegangnya. Bukan kira-kira sebesar itu: pembulatan di kedua sisi selalu diselesaikan berpihak pada cadangan, sehingga k hanya bisa tumbuh dan selisihnya menumpuk sebagai surplus. Kontraknya mengekspos angka itu sebagai rasio kesehatan cadangan, dihitung ulang dari nol setiap kali ditanya, bukan sekadar membacakan saldonya sendiri.

Fee sebesar 1% per leg diambil di luar cadangan. Artinya saldo fee kreator tidak pernah menjadi ETH yang menopang kemampuan orang lain untuk menjual. Ketika kreator menarik fee-nya, tidak ada satu wei pun dari sisi jual yang ikut terbawa — dan tombol yang memindahkan uang keluar dari kontrak sebaiknya memang menjelaskan apa yang tidak bisa dibawanya.

Menjual tidak pernah ditutup, kecuali oleh emergency stop platform yang menghentikan kedua sisi sekaligus.

Artikel yang tidak bisa dihapus, dan koreksi yang juga tidak

Blog memperbaiki dirinya dengan menulis ulang paragraf. Kalimat yang dulu meyakinkan orang lenyap, tanggal di atasnya tidak berubah, dan pembaca yang datang belakangan tidak punya cara tahu bahwa tulisan di depannya bukan tulisan yang dulu ditindaklanjuti orang.

Di blog itu ketidakjujuran kecil. Di Folio itu besar, karena ada yang membeli atas dasar kalimat tersebut.

Jadi artikelnya dikunci saat terbit. Bukan karena ada komponen yang menolak menyimpan perubahan, tapi karena kebijakan di database tidak memberi klien mana pun izin update maupun delete atas baris itu. Pikiran kedua ditambahkan, bukan menimpa: sebuah adendum bertanggal, muncul di antara artikel dan panel trading, ditandatangani oleh wallet yang sama dengan byline-nya, dan tidak bisa dicabut lagi — termasuk oleh penulisnya sendiri. Orang yang menarik ucapannya tidak bisa belakangan menarik penarikannya.

Log trading ada di halaman yang sama. Pembaca bisa melihat penulisnya berubah pikiran, kapan tepatnya, dan harga sedang berbuat apa saat itu.

Byline yang dibuktikan, bukan diketik

Nama penulis di sebuah baris database hanyalah klaim. Menerbitkan lewat situsnya membuktikannya: wallet menandatangani pesan EIP-4361 yang menyebut situs ini, alamat ini, dan nonce sekali pakai. Gratis, tanpa transaksi, tanpa gas.

Server memverifikasi tanda tangan itu lalu menerbitkan token sesi yang membawa alamatnya, dan kebijakan insert di Postgres menolak baris mana pun yang alamat kreatornya tidak sama dengan alamat yang menandatangani. Perbandingannya terjadi di database, bukan di komponen — jadi tidak ada bagian dari aplikasi yang bisa lupa melakukannya.

Listing yang diterbitkan dengan cara lain tetap boleh ada. Ia hanya jujur menyebut dirinya "Unverified byline".

Dan hal-hal yang benar-benar memindahkan uang tidak diputuskan dari sana sama sekali. Siapa yang berhak menarik fee kreator dibaca dari kontraknya, bukan dari database, karena satu baris tabel adalah otoritas yang salah untuk sebuah pembayaran.

Angka pembaca yang tidak bisa dipalsukan dengan refresh

Setiap blog memasang penghitung view, dan tidak satu pun layak dibaca: satu view berharga satu request untuk dibuat.

Sebuah launch di atas kurva punya angka yang lebih baik yang selama ini menganggur — jumlah alamat berbeda yang pernah membelinya. Memalsukan angka itu berharga satu transaksi per alamat di jaringan yang menyelesaikan pakai ETH sungguhan, dan semuanya ada di event log kontraknya sendiri, di mana siapa pun bisa menghitung ulang.

Angka itu dicetak di bawah byline — persis di tempat blog memasang view-nya. Ia tidak mengklaim jumlah holder, karena saldo juga berpindah lewat transfer biasa dan log kurva tidak tahu soal itu. Dan ketika jawabannya tidak diketahui, barisnya hilang sama sekali, bukan menampilkan nol.

Dua menit pertama

Launch dibuka dengan jendela pembuka selama dua menit, dengan batas 0,25 ETH per wallet. Pembelian di atas batas tidak ditolak — ia dipangkas dan selisihnya dikembalikan di transaksi yang sama, dan kutipan harganya sudah mengatakan itu sebelum apa pun ditandatangani.

Kreator boleh memperketatnya untuk launch-nya sendiri: jendela lebih panjang, gigitan per wallet lebih kecil. Keduanya arah yang protektif, dan tidak satu pun bisa dilonggarkan melewati batas platform. Ini membatasi alamat, bukan orang — dan dokumentasi kontraknya menuliskan sendiri apa yang tidak bisa dihentikannya, alih-alih menjualnya sebagai perlindungan penuh.

Grafik yang menolak menggambar hal yang tidak terjadi

Setiap pembelian dan penjualan membawa harga marginal yang ditinggalkannya, jadi seluruh riwayat harga sebuah launch sudah ada di on-chain tanpa perlu dicatat siapa pun agar ia ada.

Grafiknya melangkah, tidak melandai. Kurva constant product hanya bergerak ketika ada yang berdagang melawannya, jadi di antara dua transaksi harganya adalah garis datar — melandaikan garis di antara dua titik berarti mengarang drift yang tidak pernah terjadi. Harga terakhir memanjang ke tepi kanan karena alasan yang sama: itu masih harganya.

Uangnya sungguhan

Folio berjalan di satu jaringan: Robinhood Chain, sebuah L2 Arbitrum Orbit dengan chain id 4663. Itu mainnet. ETH yang dibelanjakan di sana nyata, transaksinya final, dan token yang dibeli di sana bisa kehilangan seluruh nilainya.

Tidak ada mode latihan. Folio dulu menjalankan testnet di sampingnya untuk gladi resik; jaringan itu sudah dicabut beserta setiap tautan faucet-nya, jadi tidak ada satu pun bagian dari situs ini yang berstatus gladi resik. Tidak ada faucet di mana pun di dalam kodenya, dan memang seharusnya tidak ada: gas di sini dibeli atau di-bridge, dan apa pun yang menawarkan membagikannya bukan faucet.

Ini bukan nasihat keuangan, bukan produk investasi, dan tidak ada yang menjaminnya.

Kalau mau lihat sendiri

Factory-nya ada di 0xcCdE95C857561E16E14d37f235E8cb5F5cd35469 di Robinhood Chain, dan setiap launch adalah proxy di atas satu implementasi bersama yang bisa dibaca siapa saja di explorer. Setiap halaman token menampilkan seluruh data kontraknya — terlipat, tapi ada — untuk siapa pun yang ingin memeriksa klaimnya alih-alih mempercayainya.

Tulis dulu. Kalau argumennya tidak sanggup berdiri sebagai artikel, mungkin ia memang tidak sanggup berdiri.

[URL FOLIO]

====================================================================

---

## English version

====================================================================

When the Listing Is the Article

Folio is a launchpad where a token ships as a piece of writing — and the writing cannot be edited once somebody has bought on it.

Every launchpad hands you a description field. Two hundred characters under a ticker, usually filled with three emoji and one promise. Then people send money at it.

Folio inverts the order. What you write is the article: a headline, a byline, and the piece itself making the case for why this thing exists. The token is minted from that same page, and the buy/sell panel sits at the foot of the article rather than above it. The argument comes first; the button comes after.

What makes that more than a layout decision is what happens once the button is pressed.

One transaction, one market

Publishing a launch calls one function on a factory contract. The factory clones an ERC20 that is also its own market maker — a constant-product bonding curve, x * y = k, with a virtual reserve that gives the curve a finite opening price.

There is no pool to seed, no counterparty to find and no listing fee. Buyers buy from the curve, sellers sell straight back into the reserve it holds, and every price on an article is quoted by the contract as you read it, never cached from a market somewhere else.

Because each launch is a minimal proxy over one shared implementation, creating one costs about 41k gas instead of 1.5M. To its author, a launch costs nothing but gas.

The reserve is always enough — and you can check that

This is the claim launchpads make most often and prove least often, so here is the arithmetic.

Buying back every circulating token from the curve costs exactly the ETH reserve it holds. Not approximately: rounding on both legs is resolved in the reserve's favour, so k only ever grows and the difference accumulates as surplus. The contract exposes that as a reserve health ratio, recomputed the long way round every time it is asked rather than restating its own balance.

The 1% fee on each leg is taken outside the reserve. That means a creator's fee balance is never the ETH backing somebody else's ability to sell. When a creator claims, not one wei of the sell side goes with it — and a button that moves money out of a contract ought to say what it cannot take with it.

Selling is never closed, except by a platform emergency stop that halts both sides at once.

An article nobody can delete, and corrections nobody can either

A blog corrects itself by rewriting the paragraph. The sentence that made the case disappears, the date at the top does not, and a reader arriving afterwards has no way to tell that the piece in front of them is not the piece anybody acted on.

On a blog that is a small dishonesty. Here it is a large one, because somebody bought on the strength of those words.

So the article is fixed at publication — not because a component declines to save an edit, but because the database policies grant no client an update or a delete on that row. Second thoughts are appended instead: an addendum is dated, rendered between the article and the trade panel, signed by the same wallet as the byline, and cannot be withdrawn afterwards — including by its author, which is the entire point. Someone who retracts cannot later retract the retraction.

The trade log is on the same page. A reader can see that the author changed their mind, when, and what the price was doing at the time.

A byline that is proved, not typed

An author's name in a database row is a claim. Publishing through the site proves it: the wallet signs an EIP-4361 message naming this site, this address and a single-use nonce. Free, no transaction, no gas.

The server verifies that signature and mints a session token carrying the address, and the insert policy in Postgres refuses any row whose creator address is not the one that signed. The comparison happens in the database, not in a component — so no part of the app can skip it.

Listings published another way are still allowed to exist. They just honestly call themselves an unverified byline.

And the things that actually move money are not decided from any of it. Who may claim creator fees is read off the contract, never off the database, because a table row is the wrong authority for a payout.

A readership figure a refresh cannot forge

Every blog prints a view counter and none of them is worth reading: a view costs one request to manufacture.

A launch on a curve has a better figure lying around unused — the count of distinct addresses that have bought it. Forging that costs a transaction per address on a network settling in real ETH, and every one of them is in the contract's own event log, where anybody can recount them.

It is printed under the byline, where a blog puts its views. It does not claim to be a holder count, because balances also move by plain ERC20 transfer and the curve's log knows nothing about that. And where the answer is unknown, the line is absent entirely rather than reading zero.

The first two minutes

A launch opens with a two-minute window and a 0.25 ETH cap per wallet. Buys over the cap are not refused — they are trimmed and the difference refunded in the same transaction, and the quote says so before anything is signed.

A creator can tighten it for their own launch: a longer window, a smaller bite per wallet. Both directions are the protective one, and neither can be loosened past what the platform set. It caps addresses, not people — and the contract docs write down what it does not stop, rather than selling it as full protection.

A chart that refuses to draw what did not happen

Every buy and sell carries the marginal price it left behind, so a launch's whole price history is already on chain without anything having to record it for it to exist.

The chart steps rather than slopes. A constant-product curve only moves when somebody trades against it, so between two trades the price is a flat line — sloping between the points would invent a drift that never happened. The last price runs out to the right edge for the same reason: it is still the price.

The money is real

Folio runs on one network: Robinhood Chain, an Arbitrum Orbit L2 with chain id 4663. It is a mainnet. The ETH spent there is real, the trade is final, and a token bought there can lose every bit of what it cost.

There is no practice mode. Folio used to carry a testnet alongside for rehearsal; that network is gone along with every faucet link, so nothing on this site is a rehearsal. There are no faucets anywhere in the code, and there should not be: gas here is bought or bridged, and anything offering to give it away is not a faucet.

This is not financial advice, not an investment product, and nobody is underwriting it.

If you want to check it yourself

The factory is at 0xcCdE95C857561E16E14d37f235E8cb5F5cd35469 on Robinhood Chain, and every launch is a proxy over one shared implementation anyone can read on the explorer. Each token page carries the whole of the contract's data — folded shut, but there — for anyone who would rather check a claim than take it.

Write it first. If the case cannot stand up as an article, it probably cannot stand up.

[URL FOLIO]

====================================================================

---

## Post pengantar (untuk menautkan artikelnya)

Pilih salah satu. Yang pertama Indonesia, yang kedua English.

```
Setiap launchpad kasih kamu kolom deskripsi 200 karakter.

Folio kasih kamu artikel — dan mengunci tulisannya begitu ada yang beli.

Kurva bonding-nya di dalam token itu sendiri, jadi jual-balik selalu tercover.
Koreksi ditambahkan, tidak menimpa. Byline dibuktikan pakai tanda tangan.

Saya tulis panjangnya di sini ↓
```

```
Every launchpad gives you a 200-character description field.

Folio gives you an article — and freezes it the moment somebody buys on it.

The bonding curve lives inside the token, so selling back is always covered.
Corrections are appended, never overwritten. Bylines are proved by signature.

The long version ↓
```
