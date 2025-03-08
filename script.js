window.AudioContext = window.AudioContext || window.webkitAudioContext;
window.OfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;

let context = null;
let recorder = null;
let mediaStream = null;

// ggwave instance
let ggwave = null;
let parameters = null;
let instance = null;

// DOM elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList = document.getElementById('fileList');
const sendButton = document.getElementById('sendButton');
const captureStart = document.getElementById('captureStart');
const captureStop = document.getElementById('captureStop');
const receiverStatus = document.getElementById('receiverStatus');
const progressBar = document.getElementById('progressBar');

let selectedFiles = [];

// Discord webhook URL
const discordWebhookURL = 'https://discord.com/api/webhooks/1347887778675032074/A6KRK1EZ6Ux4Vh44dKz8I9fHIjmXIVHuXxPy_GewshXnCmyENqODS2q7vcyUeVwe6Fqy';

// ----------------------------------------------------------
// Key Fixes:
// ----------------------------------------------------------

// 1. Check for getUserMedia support
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('getUserMedia is not supported in this browser.');
    alert('Your browser does not support microphone access. Please use Chrome/Firefox.');
    captureStart.disabled = true;
    captureStop.disabled = true;
} else {
    console.log('getUserMedia is supported.');
}

// 2. Initialize AudioContext after user interaction
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed.');
    captureStart.addEventListener('click', () => {
        if (!context) {
            console.log('Initializing AudioContext...');
            context = new AudioContext({ sampleRate: 48000 });
            console.log('AudioContext initialized.');
        }
    });
});

// Initialize ggwave
ggwave_factory()
    .then((obj) => {
        console.log('ggwave_factory resolved successfully.');
        ggwave = obj;
        parameters = ggwave.getDefaultParameters();
        parameters.sampleRateInp = 48000;
        parameters.sampleRateOut = 48000;
        instance = ggwave.init(parameters);
        console.log('ggwave initialized successfully.');
    })
    .catch((err) => {
        console.error('Failed to initialize ggwave:', err);
        alert('Failed to initialize ggwave. Check the console for details.');
    });

// ----------------------------------------------------------
// File handling
// ----------------------------------------------------------

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFileSelect);

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    selectedFiles = Array.from(e.dataTransfer.files);
    updateFileList();
});

function handleFileSelect(e) {
    selectedFiles = Array.from(e.target.files);
    updateFileList();
}

function updateFileList() {
    fileList.innerHTML = selectedFiles.map(file => `
        <div class="file-item">
            📄 ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)
        </div>
    `).join('');

    if (selectedFiles.length === 0) {
        fileList.innerHTML = '<div class="file-item">No files selected</div>';
    }
}

// ----------------------------------------------------------
// Sender Logic
// ----------------------------------------------------------

sendButton.addEventListener('click', async () => {
    if (!selectedFiles.length) {
        alert('Please select files first!');
        return;
    }

    // Pause audio capture during transmission
    captureStop.click();

    // Generate a 16-digit handshake code with IP and port
    const ip = await getLocalIP();
    const port = 12345; // Example port
    const handshakeCode = `${ip}:${port}`.padEnd(16, '0').slice(0, 16); // Ensure 16 digits

    console.log('Handshake code:', handshakeCode);

    // Encode handshake code into audio
    const waveform = ggwave.encode(instance, handshakeCode, ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 10);

    // Play audio
    const buf = convertTypedArray(waveform, Float32Array);
    const buffer = context.createBuffer(1, buf.length, context.sampleRate);
    buffer.getChannelData(0).set(buf);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(0);

    console.log('Playing handshake audio...');
    simulateProgress();

    // Notify Discord that file transfer is starting
    sendDiscordMessage(`📤 File transfer started. Handshake code: ${handshakeCode}`);

    // Start file transfer server
    startFileTransferServer(ip, port);
});

// Start a simple file transfer server
function startFileTransferServer(ip, port) {
    const server = new WebSocket(`ws://${ip}:${port}`);

    server.onopen = () => {
        console.log('File transfer server started.');
    };

    server.onmessage = (e) => {
        console.log('Received request for file transfer.');
        const file = selectedFiles[0]; // Send the first file for simplicity
        const reader = new FileReader();

        reader.onload = () => {
            server.send(reader.result);
            console.log('File sent successfully.');

            // Notify Discord that file transfer is complete
            sendDiscordMessage(`✅ File transfer complete: ${file.name}`);
        };

        reader.readAsArrayBuffer(file);
    };
}

// ----------------------------------------------------------
// Receiver Logic
// ----------------------------------------------------------

captureStart.addEventListener('click', () => {
    if (!context) {
        alert('Audio context not initialized. Click again.');
        return;
    }

    const constraints = {
        audio: {
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: false
        }
    };

    console.log('Requesting microphone access...');
    navigator.mediaDevices.getUserMedia(constraints)
        .then((stream) => {
            console.log('Microphone access granted.');
            mediaStream = context.createMediaStreamSource(stream);

            const bufferSize = 1024;
            recorder = context.createScriptProcessor(bufferSize, 1, 1);

            recorder.onaudioprocess = (e) => {
                const source = e.inputBuffer;
                const audioData = new Float32Array(source.getChannelData(0));
                console.log('Processing audio data:', audioData);

                const res = ggwave.decode(instance, convertTypedArray(audioData, Int8Array));

                if (res?.length > 0) {
                    const handshakeCode = new TextDecoder('utf-8').decode(res);
                    console.log('Decoded handshake code:', handshakeCode);

                    // Extract IP and port from the handshake code
                    const [ip, port] = handshakeCode.split(':');
                    console.log('Extracted IP:', ip, 'Port:', port);

                    // Notify Discord that handshake code was received
                    sendDiscordMessage(`🔍 Handshake code received: ${handshakeCode}`);

                    // Connect to the sender
                    connectToSender(ip, port);
                }
            };

            mediaStream.connect(recorder);
            recorder.connect(context.destination);
            console.log('Audio capture started.');
        })
        .catch((e) => {
            console.error('Microphone access error:', e);
            alert('Microphone access denied. Refresh and allow permissions.');
        });

    receiverStatus.textContent = 'Listening...';
    captureStart.hidden = true;
    captureStop.hidden = false;
});

// Connect to the sender and request file transfer
function connectToSender(ip, port) {
    const client = new WebSocket(`ws://${ip}:${port}`);

    client.onopen = () => {
        console.log('Connected to sender. Requesting file transfer...');
        client.send('Requesting file transfer.');
    };

    client.onmessage = (e) => {
        console.log('File received:', e.data);
        const blob = new Blob([e.data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'received_file';
        a.click();
        URL.revokeObjectURL(url);

        // Notify Discord that file was received
        sendDiscordMessage(`📥 File received: ${blob.size} bytes`);
    };
}

captureStop.addEventListener('click', () => {
    if (recorder) {
        recorder.disconnect();
        mediaStream.disconnect();
        recorder = null;
        console.log('Audio capture stopped.');
    }
    receiverStatus.textContent = 'Audio capture paused.';
    captureStart.hidden = false;
    captureStop.hidden = true;
});

// ----------------------------------------------------------
// Helper functions
// ----------------------------------------------------------

function convertTypedArray(src, type) {
    const buffer = new ArrayBuffer(src.byteLength);
    new src.constructor(buffer).set(src);
    return new type(buffer);
}

function simulateProgress() {
    let progress = 0;
    const interval = setInterval(() => {
        progress += Math.random() * 5;
        progressBar.style.width = `${Math.min(progress, 100)}%`;
        if (progress >= 100) {
            clearInterval(interval);
            console.log('Handshake complete.');
        }
    }, 200);
}

// Get local IP address
async function getLocalIP() {
    return new Promise((resolve) => {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('');
        pc.createOffer().then(offer => pc.setLocalDescription(offer));
        pc.onicecandidate = ice => {
            if (ice.candidate) {
                resolve(ice.candidate.candidate.split(' ')[4]);
                pc.close();
            }
        };
    });
}

// Send a message to Discord
function sendDiscordMessage(message) {
    fetch(discordWebhookURL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            content: message,
        }),
    })
        .then(response => {
            if (!response.ok) {
                console.error('Failed to send Discord message:', response.statusText);
            }
        })
        .catch(error => {
            console.error('Error sending Discord message:', error);
        });
}

// Initialize
captureStop.click();