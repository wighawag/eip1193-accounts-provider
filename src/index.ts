import {privateKeyToAccount, mnemonicToAccount, LocalAccount} from 'viem/accounts';

import type {EIP1193ProviderWithoutEvents, EIP1193TransactionData} from 'eip-1193';
import {
	Chain,
	createPublicClient,
	createWalletClient,
	custom,
	defineChain,
	PublicClient,
	SendTransactionParameters,
	Transport,
	WalletClient,
} from 'viem';

export type {EIP1193ProviderWithoutEvents};

export interface ProviderOptions {
	accounts?:
		| {
				privateKeys?: `0x${string}`[];
		  }
		| {mnemonic?: string; numAccounts?: number};
	impersonate?: {
		impersonator: {
			impersonateAccount: (params: {address: `0x${string}`}) => Promise<void>;
		};
	} & (
		| {
				mode: 'always' | 'unknown';
		  }
		| {
				mode: 'list';
				list: `0x${string}`[];
		  }
	);
	doNotFillMissingFields?: boolean;
	handlers: Record<string, (params?: any[]) => Promise<any>>;
}

export function extendProviderWithAccounts(
	provider: EIP1193ProviderWithoutEvents,
	options?: ProviderOptions,
): EIP1193ProviderWithoutEvents {
	let clients: {wallet: WalletClient<Transport, Chain>; public: PublicClient<Transport, Chain>} | undefined;
	async function getClients() {
		if (clients) {
			return clients;
		}
		const chainId = await provider.request({method: 'eth_chainId'});

		const chain = defineChain({
			id: Number(chainId),
			name: 'unknown',
			nativeCurrency: {symbol: 'ETH', decimals: 18, name: 'ETH'},
			rpcUrls: {
				default: {
					http: [],
				},
			},
		});
		const walletClient = createWalletClient({
			transport: custom(provider),
			chain,
		});
		const publicClient = createPublicClient({
			transport: custom(provider),
			chain,
		});
		clients = {
			wallet: walletClient,
			public: publicClient,
		};
		return clients;
	}

	const accounts: LocalAccount[] = [];
	if (options?.accounts) {
		const accountsProvided = options.accounts;
		if ('privateKeys' in accountsProvided && accountsProvided.privateKeys) {
			for (const pk of accountsProvided.privateKeys) {
				const account = privateKeyToAccount(pk);
				accounts.push(account);
				// await client.tevmSetAccount({ address: account.address, balance: 0n });
			}
		} else if ('mnemonic' in accountsProvided && accountsProvided.mnemonic) {
			const num = accountsProvided.numAccounts || 10;
			for (let i = 0; i < num; i++) {
				const account = mnemonicToAccount(accountsProvided.mnemonic, {
					accountIndex: i,
				});
				accounts.push(account);
				// await client.tevmSetAccount({ address: account.address, balance: 0n });
			}
		}
	}

	function validateTransaction(tx: EIP1193TransactionData) {
		const errors: string[] = [];
		if (!tx.from) errors.push('from');
		if (!tx.gas) errors.push('gas');
		if (!tx.nonce) errors.push('nonce');
		const txAny = tx as any;
		const hasGasPrice = txAny.gasPrice !== undefined;
		const hasMaxFee = txAny.maxFeePerGas !== undefined;
		const hasMaxPriority = txAny.maxPriorityFeePerGas !== undefined;
		if (tx.type === '0x2') {
			if (!hasMaxFee) errors.push('maxFeePerGas');
			if (!hasMaxPriority) errors.push('maxPriorityFeePerGas');
		} else {
			if (!hasGasPrice) errors.push('gasPrice');
		}
		if (errors.length > 0) {
			throw new Error(`Missing mandatory fields: ${errors.join(', ')}`);
		}
	}

	const shouldImpersonate = (address: string) => {
		if (options?.impersonate?.mode === 'always') {
			return true;
		} else if (options?.impersonate?.mode == 'unknown') {
			return !accounts.some((a) => a.address.toLowerCase() === address.toLowerCase());
		} else if (options?.impersonate?.mode === 'list') {
			return options.impersonate.list.includes(address as `0x${string}`) || false;
		}
		return false;
	};

	function toViemTransaction(tx: EIP1193TransactionData): Omit<SendTransactionParameters, 'account' | 'chain'> {
		if (tx?.type === '0x1') {
			return {
				type: 'eip2930',
				to: tx.to,
				nonce: tx.nonce ? Number(tx.nonce) : undefined,
				gas: tx.gas ? BigInt(tx.gas) : undefined,
				gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
				data: tx.data,
				accessList: tx.accessList,
				value: tx.value ? BigInt(tx.value) : undefined,
			};
		} else if (tx?.type === '0x2') {
			return {
				type: 'eip1559',
				to: tx.to,
				nonce: tx.nonce ? Number(tx.nonce) : undefined,
				gas: tx.gas ? BigInt(tx.gas) : undefined,
				maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : undefined,
				maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : undefined,
				data: tx.data,
				accessList: tx.accessList,
				value: tx.value ? BigInt(tx.value) : undefined,
				// sidecars
				// maxFeePerBlobGas
				// kzg
				// authorizationList
				// blobs
				// blobVersionedHashes
			};
		} else if (!tx.type || tx.type === '0x0') {
			return {
				type: 'eip2930',
				to: tx.to,
				nonce: tx.nonce ? Number(tx.nonce) : undefined,
				gas: tx.gas ? BigInt(tx.gas) : undefined,
				gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
				data: tx.data,
				value: tx.value ? BigInt(tx.value) : undefined,
			};
		} else {
			throw new Error(`tx type ${tx.type} not implemented`);
		}
	}

	const accountHandlers: Record<string, (params: any[]) => Promise<any>> = {
		eth_sendTransaction: async (params) => {
			const tx: EIP1193TransactionData = params[0];
			if (options?.doNotFillMissingFields) {
				validateTransaction(tx);
			}
			const viemTx = toViemTransaction(tx);
			const account = accounts.find((a) => a.address.toLowerCase() === tx.from.toLowerCase());
			const impersonate = options?.impersonate;
			const clients = await getClients();
			if (impersonate?.mode !== 'always' && account) {
				return clients.wallet.sendTransaction({
					...viemTx,
					account,
				} as any);
			} else if (impersonate) {
				if (shouldImpersonate(tx.from)) {
					await impersonate.impersonator.impersonateAccount({
						address: tx.from as `0x${string}`,
					});

					return await provider.request({
						method: 'eth_sendTransaction',
						params: [tx],
					});
				} else {
					throw new Error('Account not available, not even as impersonation');
				}
			} else {
				throw new Error('Account not available');
			}
		},
		eth_accounts: async () => {
			return accounts.map((a) => a.address);
		},
		eth_requestAccounts: async () => {
			return accounts.map((a) => a.address);
		},
		personal_sign: async (params) => {
			const [message, address] = params;
			const account = accounts.find((a) => a.address === address);
			if (!account) {
				throw new Error('Account not available for signing');
			}
			const prefixedMessage = `\x19Ethereum Signed Message:\n${message.length}${message}`;
			return account.signMessage({message: prefixedMessage});
		},
		eth_sign: async (params) => {
			const [address, message] = params;
			const account = accounts.find((a) => a.address === address);
			if (!account) {
				throw new Error('Account not available for signing');
			}
			return account.signMessage({message});
		},
		eth_signTransaction: async (params) => {
			throw new Error('eth_signTransaction not implemented');
			// const tx = params[0];
			// const account = accounts.find((a) => a.address === tx.from);
			// if (!account) {
			// 	throw new Error('Account not available for signing');
			// }
			// return account.signTransaction(signTxParams);
		},
		eth_signTypedData: async (params) => {
			const [address, typedData] = params;
			const account = accounts.find((a) => a.address === address);
			if (!account) {
				throw new Error('Account not available for signing');
			}
			return account.signTypedData(typedData);
		},
		eth_signTypedData_v4: async (params) => {
			const [address, typedData] = params;
			const account = accounts.find((a) => a.address === address);
			if (!account) {
				throw new Error('Account not available for signing');
			}
			return account.signTypedData(typedData);
		},
	};

	const handlers: Record<string, (params: any[]) => Promise<any>> = {
		...accountHandlers,
		...options?.handlers,
	};
	return {
		request: async (args: {method: string; params?: any[]}) => {
			const {method, params = []} = args;
			const handler = handlers[method];
			if (!handler) {
				return provider.request({
					method: args.method,
					params: args.params,
				} as any);
			}
			return handler(params);
		},
	} as EIP1193ProviderWithoutEvents;
}
