/**
 * EasyEDA Copilot extension entry point.
 */
import { assembleCircuit } from './eda/assemble';
import { assembleBoard } from './eda/pcb-assemble';
import extension from '../extension.json';
import { getAsmCircuit, getSchematic } from './eda/schematic';
import { getPcb, getPcbRaw } from './eda/pcb';
import '@copilot/shared/types/eda';
import { searchComponentInSCH } from './eda/search';
import { checkpointer } from './eda/checkpointer';
import { startMcpScanOnStartup, startMcpScan, stopMcpScan, toggleMcpScan } from './mcp-client';
import { checkPcbDrc } from './eda/drc';
import { getLibraryUuidList } from './eda/place-component';

const MCP_WS_ID = 'easyeda-copilot-mcp';
const MCP_WS_URL_DEFAULT = 'ws://127.0.0.1:8787';
const MCP_WS_URL_STORAGE_KEY = 'easyeda-copilot-mcp-ws-url';
const MCP_WS_REGISTER_PATCH_KEY = '__easyedaCopilotRemoteMcpPatched';

function isValidMcpWsUrl(value: string) {
	return /^wss?:\/\/[^\s]+$/i.test(value.trim());
}

function getConfiguredMcpWsUrl() {
	try {
		const value = globalThis.localStorage?.getItem(MCP_WS_URL_STORAGE_KEY)?.trim();
		if (value && isValidMcpWsUrl(value)) return value;
	} catch {
		// Storage may be unavailable in some EasyEDA runtimes.
	}
	return MCP_WS_URL_DEFAULT;
}

function patchMcpWebSocketUrl() {
	const socketApi = eda.sys_WebSocket as typeof eda.sys_WebSocket & {
		[MCP_WS_REGISTER_PATCH_KEY]?: boolean;
		register: (...args: any[]) => unknown;
	};
	if (socketApi[MCP_WS_REGISTER_PATCH_KEY]) return;

	const originalRegister = socketApi.register.bind(socketApi);
	socketApi.register = ((id: string, url: string, ...args: any[]) => {
		const targetUrl = id === MCP_WS_ID ? getConfiguredMcpWsUrl() : url;
		return originalRegister(id, targetUrl, ...args);
	}) as typeof socketApi.register;
	socketApi[MCP_WS_REGISTER_PATCH_KEY] = true;
}

async function reconnectMcp() {
	stopMcpScan(false);
	startMcpScan(true);
}

eda.assembleCircuit = assembleCircuit;
eda.assembleBoard = assembleBoard;
eda.getSchematic = getSchematic;
eda.getPcb = getPcb;
eda.getPcbRaw = getPcbRaw;
eda.getAsmCircuit = getAsmCircuit;
eda.searchComponentInSCH = searchComponentInSCH;
eda.checkpointer = checkpointer;
eda.checkPcbDrc = checkPcbDrc;
eda.getLibraryUuidList = getLibraryUuidList;

patchMcpWebSocketUrl();
startMcpScanOnStartup();

export function activate(status?: 'onStartupFinished', arg?: string) {
	patchMcpWebSocketUrl();
	startMcpScanOnStartup();
}

export async function about() {
	eda.sys_Dialog.showInformationMessage(`${extension.displayName} Extension\nVersion ${extension.version}\n\nRepository ${extension.repository.url}\n\nDeveloped by ${extension.publisher}`);
}

export async function openInterface() {
	eda.sys_IFrame.openIFrame('/iframe/index.html', 520, 700);
}

export async function openMcp() {
	toggleMcpScan();
}

export async function configureMcpConnection() {
	const current = getConfiguredMcpWsUrl();
	const promptFn = (globalThis as typeof globalThis & {
		prompt?: (message?: string, defaultValue?: string) => string | null;
	}).prompt;

	if (!promptFn) {
		eda.sys_Dialog.showInformationMessage(`MCP WebSocket URL: ${current}\n\nThis EasyEDA runtime does not expose a prompt dialog.`);
		return;
	}

	const value = promptFn(
		'MCP WebSocket URL. Use ws://127.0.0.1:8787 for local Codex/MCP, or ws://<LAN-IP>:8787 when Codex runs on another computer.',
		current,
	);
	if (value === null) return;

	const normalized = value.trim() || MCP_WS_URL_DEFAULT;
	if (!isValidMcpWsUrl(normalized)) {
		eda.sys_Message.showToastMessage('Invalid MCP WebSocket URL', ESYS_ToastMessageType.ERROR);
		return;
	}

	try {
		globalThis.localStorage?.setItem(MCP_WS_URL_STORAGE_KEY, normalized);
	} catch {
		eda.sys_Message.showToastMessage('Unable to save MCP WebSocket URL', ESYS_ToastMessageType.ERROR);
		return;
	}

	await reconnectMcp();
	eda.sys_Message.showToastMessage(`MCP endpoint: ${normalized}`, ESYS_ToastMessageType.SUCCESS);
}

export async function resetMcpConnection() {
	try {
		globalThis.localStorage?.removeItem(MCP_WS_URL_STORAGE_KEY);
	} catch {
		// Ignore storage errors and still attempt the reconnect.
	}
	await reconnectMcp();
	eda.sys_Message.showToastMessage(`MCP endpoint reset: ${MCP_WS_URL_DEFAULT}`, ESYS_ToastMessageType.SUCCESS);
}

export async function importAsmCircuit() {
	eda.sys_FileSystem.openReadFileDialog(undefined, false).then(async (file) => {
		if (!file) return eda.sys_Message.showToastMessage('No file', ESYS_ToastMessageType.ERROR);
		const text = await file.text();
		const json = JSON.parse(text);
		assembleCircuit(json);
	});
}

export async function importAsmBoard() {
	eda.sys_FileSystem.openReadFileDialog(undefined, false).then(async (file) => {
		if (!file) return eda.sys_Message.showToastMessage('No file', ESYS_ToastMessageType.ERROR);
		const text = await file.text();
		const json = JSON.parse(text);
		assembleBoard(json);
	});
}

export async function exportAsmCircuit() {
	const asmCircuit = await getAsmCircuit(await eda.sch_PrimitiveComponent.getAllPrimitiveId().then(r => [...r]));
	eda.sys_FileSystem.saveFile(new Blob([JSON.stringify(asmCircuit, null, 2)], { type: 'text/plain' }), 'asm_circuit.json');
}

export async function openReused() {
	eda.sys_IFrame.openIFrame('/iframe/reused.html', 900, 700);
}
