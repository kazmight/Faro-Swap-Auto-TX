require('dotenv').config();
const Web3 = require('web3');
const axios = require('axios');
const chalk = require('chalk'); // Untuk log berwarna
const figlet = require('figlet'); // Untuk banner ASCII

// --- Konfigurasi Umum ---
const RPC_URL = "https://testnet.dplabs-internal.com";
const PHRS_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"; // Alamat token native
const WPHRS_ADDRESS = "0x3019b247381c850ab53dc0ee53bce7a07ea9155f"; // Alamat Wrapped PHRS
const USDT_ADDRESS = "0xd4071393f8716661958f766df660033b3d35fd29"; // Alamat token USDT test
const ROUTER_ADDRESS = "0x3541423f25a1ca5c98fdbcf478405d3f0aad1164"; // Alamat FaroSwap Router
const LP_ADDRESS = "0x4b177aded3b8bd1d5d747f91b9e853513838cd49"; // Alamat FaroSwap LP Pool (DVM)
const FAUCET_USDT_URL = "https://testnet-router.zenithswap.xyz/api/v1/faucet"; // URL Faucet USDT

// --- Variabel Repetisi ---
const SWAP_REPETITIONS = 10;
const SEND_PHRS_REPETITIONS = 10;
const ADD_LIQUIDITY_REPETITIONS = 10;

// --- Private Keys dari .env ---
const ALL_PRIVATE_KEYS_STRING = process.env.PRIVATE_KEYS;
if (!ALL_PRIVATE_KEYS_STRING) {
    console.error(chalk.bgRed.white(`❌ ERROR: PRIVATE_KEYS tidak ditemukan di file .env. Harap atur.`));
    process.exit(1);
}
const privateKeys = ALL_PRIVATE_KEYS_STRING.split(',').map(key => key.trim());

// --- Alamat Penerima PHRS (opsional) dari .env ---
const RECIPIENT_PHRS_ADDRESS = process.env.RECIPIENT_PHRS_ADDRESS || "0x0000000000000000000000000000000000000000";

// --- ABI Definitions ---
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

const WPHRS_ABI = [
    "function deposit() payable",
    "function withdraw(uint256 wad)",
    "function balanceOf(address owner) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

const ROUTER_ABI = [
    "function mixSwap(address fromToken, address toToken, uint256 fromAmount, uint256 resAmount, uint256 minReturnAmount, address[] memory proxyList, address[] memory poolList, address[] memory routeList, uint256 direction, bytes[] memory moreInfos, uint256 deadLine) external payable returns (uint256)"
];

const LP_ABI = [
    "function addDVMLiquidity(address dvmAddress, uint256 baseInAmount, uint256 quoteInAmount, uint256 baseMinAmount, uint256 quoteMinAmount, uint8 flag, uint256 deadLine) external payable returns (uint256, uint256, uint256)"
];

// --- Inisialisasi Web3 ---
const web3 = new Web3(RPC_URL);

// Daftar untuk menyimpan objek akun Web3 setelah diinisialisasi
const accounts = [];

/**
 * Menginisialisasi semua akun dari private key yang diberikan.
 * Menambahkan mereka ke Web3 wallet untuk penandatanganan otomatis.
 */
async function initializeAccounts() {
    console.log(chalk.blue(`\n${chalk.bold('🚀 Inisialisasi Akun...')}`));
    for (const pk of privateKeys) {
        try {
            const account = web3.eth.accounts.privateKeyToAccount(pk);
            accounts.push({
                privateKey: pk,
                address: account.address,
                wallet: web3.eth.accounts.wallet.add(account) // Menambahkan ke Web3 wallet
            });
            console.log(chalk.green(`  ✅ Akun diinisialisasi: ${account.address}`));
        } catch (error) {
            console.error(chalk.red(`  ❌ Gagal menginisialisasi private key: ${pk.substring(0, 10)}... Error: ${error.message}`));
        }
    }
    if (accounts.length === 0) {
        console.error(chalk.bgRed.white(`❌ ERROR: Tidak ada akun yang berhasil diinisialisasi. Pastikan private key valid.`));
        process.exit(1);
    }
}

// --- Helper Functions ---

/**
 * Mengambil desimal token ERC-20. Default 18 jika tidak dapat diambil atau untuk PHRS native.
 * @param {string} tokenAddress - Alamat kontrak token.
 * @returns {Promise<number>} Jumlah desimal.
 */
async function getTokenDecimals(tokenAddress) {
    if (tokenAddress === PHRS_ADDRESS) {
        return 18;
    }
    const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
    try {
        const decimals = await tokenContract.methods.decimals().call();
        return parseInt(decimals);
    } catch (error) {
        console.warn(chalk.yellow(`⚠️ Peringatan: Tidak dapat mengambil desimal untuk ${tokenAddress}. Mengasumsikan 18. Error: ${error.message}`));
        return 18;
    }
}

/**
 * Menyetujui token untuk alamat spender.
 * @param {object} accountInfo - Objek akun saat ini (berisi privateKey dan address).
 * @param {string} tokenAddress - Alamat token yang akan disetujui.
 * @param {string} spenderAddress - Alamat spender (misalnya, router, pool LP).
 * @param {BN} amount - Jumlah dalam Wei yang akan disetujui.
 * @returns {Promise<object|null>} Resi transaksi atau null jika sudah disetujui.
 */
async function approveToken(accountInfo, tokenAddress, spenderAddress, amount) {
    const { address, privateKey } = accountInfo;

    if (tokenAddress === PHRS_ADDRESS) {
        return null; // Token native tidak perlu persetujuan
    }

    const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
    const currentAllowance = await tokenContract.methods.allowance(address, spenderAddress).call();

    if (web3.utils.toBN(currentAllowance).lt(amount)) {
        console.log(chalk.cyan(`    ⏳ Menyetujui ${web3.utils.fromWei(amount.toString(), 'ether')} token untuk ${spenderAddress}...`));
        try {
            const tx = tokenContract.methods.approve(spenderAddress, amount);
            const gas = await tx.estimateGas({ from: address });
            const gasPrice = await web3.eth.getGasPrice();
            const data = tx.encodeABI();

            const transaction = {
                from: address,
                to: tokenAddress,
                data: data,
                gas: gas,
                gasPrice: gasPrice
            };

            const signedTx = await web3.eth.accounts.signTransaction(transaction, privateKey);
            const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
            console.log(chalk.green(`    ✅ Persetujuan berhasil: ${receipt.transactionHash}`));
            return receipt;
        } catch (error) {
            console.error(chalk.red(`    ❌ Gagal menyetujui token: ${error.message}`));
            return null;
        }
    } else {
        console.log(chalk.gray(`    ℹ️ Token sudah disetujui atau persetujuan cukup.`));
        return null;
    }
}

/**
 * Mendapatkan saldo token (PHRS atau ERC-20) untuk alamat tertentu.
 * @param {string} tokenAddress - Alamat token.
 * @param {string} address - Alamat wallet yang akan diperiksa.
 * @returns {Promise<number>} Saldo sebagai float.
 */
async function getBalance(tokenAddress, address) {
    if (tokenAddress === PHRS_ADDRESS) {
        const balanceWei = await web3.eth.getBalance(address);
        return parseFloat(web3.utils.fromWei(balanceWei, 'ether'));
    } else {
        const tokenContract = new web3.eth.Contract(ERC20_ABI, tokenAddress);
        const balanceWei = await tokenContract.methods.balanceOf(address).call();
        const decimals = await getTokenDecimals(tokenAddress);
        return parseFloat(balanceWei) / (10 ** decimals);
    }
}

/**
 * Meminta USDT test dari faucet.
 * @param {string} address - Alamat yang akan menerima USDT.
 * @returns {Promise<object>} Data respons faucet.
 */
async function requestFaucetUSDT(address) {
    console.log(chalk.blue(`  ⏳ Meminta USDT dari faucet untuk ${address}...`));
    try {
        const response = await axios.post(FAUCET_USDT_URL, { address: address });
        if (response.data.code === 200) {
            console.log(chalk.green(`  ✅ Permintaan faucet berhasil: ${response.data.msg}`));
        } else {
            console.error(chalk.red(`  ❌ Permintaan faucet gagal: ${response.data.msg}`));
        }
        return response.data;
    } catch (error) {
        console.error(chalk.red(`  ❌ Error saat meminta faucet: ${error.message}`));
        if (error.response && error.response.data && error.response.data.msg) {
             console.error(chalk.red(`  Detail Error Faucet: ${error.response.data.msg}`));
        }
        return null;
    }
}

/**
 * Mengonversi PHRS native menjadi WPHRS.
 * @param {object} accountInfo - Objek akun saat ini.
 * @param {number} amountFloat - Jumlah PHRS yang akan dibungkus.
 * @returns {Promise<object>} Resi transaksi.
 */
async function wrapPHRS(accountInfo, amountFloat) {
    const { address, privateKey } = accountInfo;
    console.log(chalk.blue(`  ⏳ Membungkus ${amountFloat} PHRS menjadi WPHRS untuk ${address}...`));
    try {
        const amountWei = web3.utils.toWei(amountFloat.toString(), 'ether');
        const wphrsContract = new web3.eth.Contract(WPHRS_ABI, WPHRS_ADDRESS);

        const tx = wphrsContract.methods.deposit();
        const gas = await tx.estimateGas({ from: address, value: amountWei });
        const gasPrice = await web3.eth.getGasPrice();
        const data = tx.encodeABI();

        const transaction = {
            from: address,
            to: WPHRS_ADDRESS,
            data: data,
            gas: gas,
            gasPrice: gasPrice,
            value: amountWei
        };

        const signedTx = await web3.eth.accounts.signTransaction(transaction, privateKey);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        console.log(chalk.green(`  ✅ Bungkus PHRS berhasil: ${receipt.transactionHash}`));
        return receipt;

    } catch (error) {
        console.error(chalk.red(`  ❌ Gagal membungkus PHRS untuk ${address}: ${error.message}`));
        if (error.receipt) {
            console.error(chalk.red(`  Resi Transaksi: ${JSON.stringify(error.receipt, null, 2)}`));
        }
        return null;
    }
}

/**
 * Mengirim PHRS native ke alamat penerima.
 * @param {object} accountInfo - Objek akun saat ini.
 * @param {string} recipientAddress - Alamat penerima PHRS.
 * @param {number} amountFloat - Jumlah PHRS yang akan dikirim.
 * @returns {Promise<object>} Resi transaksi.
 */
async function sendPHRS(accountInfo, recipientAddress, amountFloat) {
    const { address, privateKey } = accountInfo;
    console.log(chalk.blue(`  ⏳ Mengirim ${amountFloat} PHRS dari ${address} ke ${recipientAddress}...`));
    try {
        const amountWei = web3.utils.toWei(amountFloat.toString(), 'ether');

        const gas = await web3.eth.estimateGas({ from: address, to: recipientAddress, value: amountWei });
        const gasPrice = await web3.eth.getGasPrice();

        const transaction = {
            from: address,
            to: recipientAddress,
            value: amountWei,
            gas: gas,
            gasPrice: gasPrice
        };

        const signedTx = await web3.eth.accounts.signTransaction(transaction, privateKey);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        console.log(chalk.green(`  ✅ Kirim PHRS berhasil: ${receipt.transactionHash}`));
        return receipt;

    } catch (error) {
        console.error(chalk.red(`  ❌ Gagal mengirim PHRS dari ${address}: ${error.message}`));
        if (error.receipt) {
            console.error(chalk.red(`  Resi Transaksi: ${JSON.stringify(error.receipt, null, 2)}`));
        }
        return null;
    }
}

/**
 * Melakukan operasi mixSwap di FaroSwap.
 * @param {object} accountInfo - Objek akun saat ini.
 * @param {string} fromTokenAddress - Alamat token asal swap.
 * @param {string} toTokenAddress - Alamat token tujuan swap.
 * @param {number} fromAmountFloat - Jumlah token asal yang akan di-swap.
 * @param {number} minReturnAmountFloat - Jumlah minimum token tujuan yang diharapkan.
 * @returns {Promise<object>} Resi transaksi.
 */
async function performMixSwap(accountInfo, fromTokenAddress, toTokenAddress, fromAmountFloat, minReturnAmountFloat) {
    const { address, privateKey } = accountInfo;
    console.log(chalk.blue(`  ⏳ Memulai mixSwap: ${fromAmountFloat} dari ${fromTokenAddress} ke ${toTokenAddress} untuk ${address}...`));

    try {
        const fromTokenDecimals = await getTokenDecimals(fromTokenAddress);
        const toTokenDecimals = await getTokenDecimals(toTokenAddress);

        const fromAmountWei = web3.utils.toBN(fromAmountFloat * (10 ** fromTokenDecimals));
        const minReturnAmountWei = web3.utils.toBN(minReturnAmountFloat * (10 ** toTokenDecimals));

        await approveToken(accountInfo, fromTokenAddress, ROUTER_ADDRESS, fromAmountWei);

        // --- SANGAT PENTING: Parameter ini perlu dikonfirmasi dari dokumentasi/sumber FaroSwap ---
        // Nilai placeholder - Anda HARUS mendapatkan nilai yang benar untuk ini!
        const resAmount = web3.utils.toBN(0);
        const proxyList = [];
        const poolList = [];
        const routeList = [];
        const direction = 0; // Konfirmasi 0 atau 1 untuk arah swap yang diinginkan
        const moreInfos = [];

        const deadLine = Math.floor(Date.now() / 1000) + (60 * 20); // 20 menit dari sekarang

        const swapTx = faroSwapRouter.methods.mixSwap(
            fromTokenAddress,
            toTokenAddress,
            fromAmountWei,
            resAmount,
            minReturnAmountWei,
            proxyList,
            poolList,
            routeList,
            direction,
            moreInfos,
            deadLine
        );

        const gas = await swapTx.estimateGas({ from: address, value: fromTokenAddress === PHRS_ADDRESS ? fromAmountWei : 0 });
        const gasPrice = await web3.eth.getGasPrice();
        const data = swapTx.encodeABI();

        const transaction = {
            from: address,
            to: ROUTER_ADDRESS,
            data: data,
            gas: gas,
            gasPrice: gasPrice,
            value: fromTokenAddress === PHRS_ADDRESS ? fromAmountWei : 0
        };

        const signedTx = await web3.eth.accounts.signTransaction(transaction, privateKey);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        console.log(chalk.green(`  ✅ mixSwap berhasil: ${receipt.transactionHash}`));

        if (receipt.events && receipt.events.MixSwap) { // Ganti 'MixSwap' dengan nama event sebenarnya dari FaroSwap
            console.log(chalk.cyan(`    Detail Event Swap (dari resi): ${JSON.stringify(receipt.events.MixSwap.returnValues)}`));
        } else {
            console.log(chalk.yellow(`    ⚠️ Tidak ada event swap spesifik yang ditemukan di resi. Periksa block explorer.`));
        }
        return receipt;

    } catch (error) {
        console.error(chalk.red(`  ❌ Gagal mixSwap untuk ${address}: ${error.message}`));
        if (error.receipt) {
            console.error(chalk.red(`  Resi Transaksi: ${JSON.stringify(error.receipt, null, 2)}`));
        }
        return null;
    }
}

/**
 * Menambah likuiditas ke DVM pool di FaroSwap.
 * @param {object} accountInfo - Objek akun saat ini.
 * @param {string} dvmAddress - Alamat DVM pool.
 * @param {string} baseTokenAddress - Alamat token dasar.
 * @param {string} quoteTokenAddress - Alamat token quote.
 * @param {number} baseInAmountFloat - Jumlah token dasar yang akan ditambahkan.
 * @param {number} quoteInAmountFloat - Jumlah token quote yang akan ditambahkan.
 * @param {number} baseMinAmountFloat - Jumlah minimum token dasar yang akan ditambahkan.
 * @param {number} quoteMinAmountFloat - Jumlah minimum token quote yang akan ditambahkan.
 * @returns {Promise<object>} Resi transaksi.
 */
async function addDVMLiquidity(accountInfo, dvmAddress, baseTokenAddress, quoteTokenAddress, baseInAmountFloat, quoteInAmountFloat, baseMinAmountFloat, quoteMinAmountFloat) {
    const { address, privateKey } = accountInfo;
    console.log(chalk.blue(`  ⏳ Menambah likuiditas ke DVM Pool ${dvmAddress} untuk ${address}...`));

    try {
        const baseTokenDecimals = await getTokenDecimals(baseTokenAddress);
        const quoteTokenDecimals = await getTokenDecimals(quoteTokenAddress);

        const baseInAmountWei = web3.utils.toBN(baseInAmountFloat * (10 ** baseTokenDecimals));
        const quoteInAmountWei = web3.utils.toBN(quoteInAmountFloat * (10 ** quoteTokenDecimals));
        const baseMinAmountWei = web3.utils.toBN(baseMinAmountFloat * (10 ** baseTokenDecimals));
        const quoteMinAmountWei = web3.utils.toBN(quoteInAmountFloat * (10 ** quoteTokenDecimals));

        await approveToken(accountInfo, baseTokenAddress, dvmAddress, baseInAmountWei);
        await approveToken(accountInfo, quoteTokenAddress, dvmAddress, quoteInAmountWei);

        const flag = 0; // Konfirmasi arti 'flag' dari dokumentasi FaroSwap
        const deadLine = Math.floor(Date.now() / 1000) + (60 * 20);

        const addLiquidityTx = faroSwapLP.methods.addDVMLiquidity(
            dvmAddress,
            baseInAmountWei,
            quoteInAmountWei,
            baseMinAmountWei,
            quoteMinAmountWei,
            flag,
            deadLine
        );

        const gas = await addLiquidityTx.estimateGas({ from: address, value: baseTokenAddress === PHRS_ADDRESS ? baseInAmountWei : 0 });
        const gasPrice = await web3.eth.getGasPrice();
        const data = addLiquidityTx.encodeABI();

        const transaction = {
            from: address,
            to: dvmAddress,
            data: data,
            gas: gas,
            gasPrice: gasPrice,
            value: baseTokenAddress === PHRS_ADDRESS ? baseInAmountWei : 0
        };

        const signedTx = await web3.eth.accounts.signTransaction(transaction, privateKey);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
        console.log(chalk.green(`  ✅ Tambah likuiditas berhasil: ${receipt.transactionHash}`));
        return receipt;

    } catch (error) {
        console.error(chalk.red(`  ❌ Gagal menambah likuiditas untuk ${address}: ${error.message}`));
        if (error.receipt) {
            console.error(chalk.red(`  Resi Transaksi: ${JSON.stringify(error.receipt, null, 2)}`));
        }
        return null;
    }
}

// --- Logika Eksekusi Utama ---

/**
 * Fungsi utama untuk menjalankan semua transaksi otomatis.
 */
async function main() {
    // Tampilkan banner ASCII
    console.log(chalk.cyan(figlet.textSync('FAROSWAP BOT', { horizontalLayout: 'full' })));

    console.log(chalk.blue(`\n======================================================`));
    console.log(chalk.blue(`  Skrip Otomatisasi Testnet FaroSwap`));
    console.log(chalk.blue(`======================================================`));
    console.log(chalk.blue(`  Terhubung ke RPC: ${RPC_URL}`));
    console.log(chalk.blue(`======================================================\n`));

    await initializeAccounts();

    if (accounts.length === 0) {
        console.error(chalk.bgRed.white(`❌ ERROR: Tidak ada akun yang dapat diproses. Script berhenti.`));
        return;
    }

    // Loop melalui setiap akun
    for (const account of accounts) {
        console.log(chalk.magenta(`\n\n${chalk.bold('████████████████████████████████████████████████████')}`));
        console.log(chalk.magenta(`████ Memproses Akun: ${chalk.yellow(account.address)} ████`));
        console.log(chalk.magenta(`████████████████████████████████████████████████████\n`));

        // --- Cek Saldo Awal untuk Akun Saat Ini ---
        console.log(chalk.blue(`--- Saldo Awal Akun ${account.address} ---`));
        const phrsBalance = await getBalance(PHRS_ADDRESS, account.address);
        const usdtBalance = await getBalance(USDT_ADDRESS, account.address);
        const wphrsBalance = await getBalance(WPHRS_ADDRESS, account.address);
        console.log(chalk.cyan(`  PHRS: ${phrsBalance.toFixed(6)} PHRS`));
        console.log(chalk.cyan(`  USDT: ${usdtBalance.toFixed(6)} USDT`));
        console.log(chalk.cyan(`  WPHRS: ${wphrsBalance.toFixed(6)} WPHRS`));
        console.log(chalk.blue(`-----------------------------------------\n`));

        // --- Opsional: Minta USDT dari Faucet ---
        // Aktifkan jika Anda sering membutuhkan USDT test
        // console.log(chalk.blue(`--- Meminta USDT dari Faucet ---`));
        // await requestFaucetUSDT(account.address);
        // await new Promise(resolve => setTimeout(resolve, 5000)); // Beri waktu faucet untuk memproses
        // console.log(chalk.cyan(`  Saldo USDT terbaru: ${await getBalance(USDT_ADDRESS, account.address).toFixed(6)} USDT\n`));

        // --- Opsional: Tambah WPHRS awal dengan membungkus PHRS ---
        // Aktifkan jika Anda membutuhkan WPHRS untuk memulai. Pastikan Anda punya PHRS native!
        // const phrsToWrap = 0.005; // Jumlah PHRS native yang akan dibungkus
        // if (phrsBalance >= phrsToWrap) {
        //     console.log(chalk.blue(`--- Membungkus ${phrsToWrap} PHRS ke WPHRS ---`));
        //     await wrapPHRS(account, phrsToWrap);
        //     await new Promise(resolve => setTimeout(resolve, 5000)); // Beri waktu transaksi
        //     console.log(chalk.cyan(`  Saldo WPHRS terbaru: ${await getBalance(WPHRS_ADDRESS, account.address).toFixed(6)} WPHRS`));
        //     console.log(chalk.cyan(`  Saldo PHRS terbaru: ${await getBalance(PHRS_ADDRESS, account.address).toFixed(6)} PHRS\n`));
        // } else {
        //     console.warn(chalk.yellow(`  ⚠️ PHRS native tidak cukup untuk dibungkus. Anda punya ${phrsBalance} PHRS, butuh ${phrsToWrap}. Melewatkan pembungkusan.\n`));
        // }

        // --- Lakukan Swap ---
        console.log(chalk.blue(`\n--- Memulai ${SWAP_REPETITIONS} Repetisi Swap untuk ${account.address} ---`));
        for (let i = 0; i < SWAP_REPETITIONS; i++) {
            console.log(chalk.yellow(`\n--- SWAP Repetisi ${i + 1}/${SWAP_REPETITIONS} (USDT -> WPHRS) ---`));
            const usdtToSwap = 0.001; // Jumlah USDT untuk swap per repetisi
            const minWphrsReturn = 0.0000001; // WPHRS minimum yang diharapkan (sesuaikan dengan harga & slippage)

            const currentUsdtBalance = await getBalance(USDT_ADDRESS, account.address);
            if (currentUsdtBalance >= usdtToSwap) {
                await performMixSwap(account, USDT_ADDRESS, WPHRS_ADDRESS, usdtToSwap, minWphrsReturn);
            } else {
                console.warn(chalk.red(`  ❌ Saldo USDT tidak cukup untuk swap. Anda punya ${currentUsdtBalance}, butuh ${usdtToSwap}. Melewatkan swap ini.`));
            }
            await new Promise(resolve => setTimeout(resolve, 7000)); // Jeda antar swap
        }
        console.log(chalk.blue(`\n--- Selesai ${SWAP_REPETITIONS} Repetisi Swap ---`));

        // --- Lakukan Kirim PHRS ---
        console.log(chalk.blue(`\n--- Memulai ${SEND_PHRS_REPETITIONS} Repetisi Kirim PHRS untuk ${account.address} ---`));
        const phrsToSend = 0.00001; // Jumlah PHRS yang akan dikirim per repetisi

        if (RECIPIENT_PHRS_ADDRESS === "0x0000000000000000000000000000000000000000") {
            console.warn(chalk.red(`\n  ❌ PERINGATAN: Harap ganti '0x0000000000000000000000000000000000000000' di .env dengan alamat penerima PHRS yang valid. Melewatkan pengiriman PHRS.\n`));
        } else {
            for (let i = 0; i < SEND_PHRS_REPETITIONS; i++) {
                console.log(chalk.yellow(`\n--- KIRIM PHRS Repetisi ${i + 1}/${SEND_PHRS_REPETITIONS} ---`));
                const currentPhrsBalance = await getBalance(PHRS_ADDRESS, account.address);
                if (currentPhrsBalance >= phrsToSend + 0.000005) { // Tambah sedikit untuk gas
                    await sendPHRS(account, RECIPIENT_PHRS_ADDRESS, phrsToSend);
                } else {
                    console.warn(chalk.red(`  ❌ Saldo PHRS tidak cukup untuk mengirim. Anda punya ${currentPhrsBalance}, butuh sekitar ${phrsToSend}. Melewatkan pengiriman ini.`));
                }
                await new Promise(resolve => setTimeout(resolve, 7000)); // Jeda
            }
        }
        console.log(chalk.blue(`\n--- Selesai ${SEND_PHRS_REPETITIONS} Repetisi Kirim PHRS ---`));

        // --- Lakukan Tambah Likuiditas ---
        console.log(chalk.blue(`\n--- Memulai ${ADD_LIQUIDITY_REPETITIONS} Repetisi Tambah Likuiditas untuk ${account.address} ---`));
        const baseLiquidityAmount = 0.0001; // Jumlah WPHRS yang akan ditambahkan
        const quoteLiquidityAmount = 0.01; // Jumlah USDT yang akan ditambahkan
        const minBaseReturn = 0.00005;
        const minQuoteReturn = 0.005;

        for (let i = 0; i < ADD_LIQUIDITY_REPETITIONS; i++) {
            console.log(chalk.yellow(`\n--- TAMBAH LIKUIDITAS Repetisi ${i + 1}/${ADD_LIQUIDITY_REPETITIONS} ---`));
            const currentWphrsBalance = await getBalance(WPHRS_ADDRESS, account.address);
            const currentUsdtBalance = await getBalance(USDT_ADDRESS, account.address);

            if (currentWphrsBalance >= baseLiquidityAmount && currentUsdtBalance >= quoteLiquidityAmount) {
                await addDVMLiquidity(account, LP_ADDRESS, WPHRS_ADDRESS, USDT_ADDRESS, baseLiquidityAmount, quoteLiquidityAmount, minBaseReturn, minQuoteReturn);
            } else {
                console.warn(chalk.red(`  ❌ Saldo token tidak cukup untuk menambah likuiditas. WPHRS: ${currentWphrsBalance}/${baseLiquidityAmount}, USDT: ${currentUsdtBalance}/${quoteLiquidityAmount}. Melewatkan penambahan likuiditas ini.`));
            }
            await new Promise(resolve => setTimeout(resolve, 10000)); // Jeda lebih lama untuk transaksi LP
        }
        console.log(chalk.blue(`\n--- Selesai ${ADD_LIQUIDITY_REPETITIONS} Repetisi Tambah Likuiditas ---`));

        // --- Cek Saldo Akhir untuk Akun Saat Ini ---
        console.log(chalk.magenta(`\n\n████ Saldo Akhir Akun: ${chalk.yellow(account.address)} ████`));
        const finalPhrsBalance = await getBalance(PHRS_ADDRESS, account.address);
        const finalUsdtBalance = await getBalance(USDT_ADDRESS, account.address);
        const finalWphrsBalance = await getBalance(WPHRS_ADDRESS, account.address);
        console.log(chalk.cyan(`  PHRS: ${finalPhrsBalance.toFixed(6)} PHRS`));
        console.log(chalk.cyan(`  USDT: ${finalUsdtBalance.toFixed(6)} USDT`));
        console.log(chalk.cyan(`  WPHRS: ${finalWphrsBalance.toFixed(6)} WPHRS`));
        console.log(chalk.magenta(`████████████████████████████████████████████████████\n`));

        await new Promise(resolve => setTimeout(resolve, 15000)); // Jeda sebelum ke akun berikutnya
    }

    console.log(chalk.green(`\n======================================================`));
    console.log(chalk.green(`  ✅ Semua Akun Telah Selesai Diproses!`);
    console.log(chalk.green(`======================================================\n`));
}

// Mulai eksekusi script
main();
