import {privateKeyToAccount, mnemonicToAccount, LocalAccount} from 'viem/accounts';

import type {EIP1193ProviderWithoutEvents} from 'eip-1193';

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
	fixes?: {
		tevmPendingCount?: boolean;
	};
}

export async function extendProviderWithAccounts(
	provider: EIP1193ProviderWithoutEvents,
	options?: ProviderOptions,
): Promise<EIP1193ProviderWithoutEvents> {
	function parseTxParams(tx: any): any {
		const params: any = {};
		if (tx.to) params.to = tx.to;
		if (tx.data) params.data = tx.data;
		if (tx.gas) params.gas = BigInt(tx.gas);
		if (tx.nonce) params.nonce = parseInt(tx.nonce, 16);
		if (tx.chainId) params.chainId = parseInt(tx.chainId, 16);
		if (tx.accessList) params.accessList = tx.accessList;
		if (tx.type === '0x1') {
			params.type = 'eip2930';
			if (tx.gasPrice) params.gasPrice = BigInt(tx.gasPrice);
		} else if (tx.type === '0x2') {
			params.type = 'eip1559';
			if (tx.maxFeePerGas) params.maxFeePerGas = BigInt(tx.maxFeePerGas);
			if (tx.maxPriorityFeePerGas) params.maxPriorityFeePerGas = BigInt(tx.maxPriorityFeePerGas);
		} else {
			params.type = 'legacy';
			if (tx.gasPrice) params.gasPrice = BigInt(tx.gasPrice);
		}
		return params;
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
	const shouldImpersonate = (address: string) => {
		if (options?.impersonate?.mode === 'always') {
			return true;
		} else if (options?.impersonate?.mode == 'unknown') {
			return !accounts.some((a) => a.address === address);
		} else if (options?.impersonate?.mode === 'list') {
			return options.impersonate.list.includes(address as `0x${string}`) || false;
		}
		return false;
	};

	const accountHandlers: Record<string, (params: any[]) => Promise<any>> = {
		eth_sendTransaction: async (params) => {
			const tx = params[0];
			const account = accounts.find((a) => a.address === tx.from);
			const impersonate = options?.impersonate;

			if (impersonate?.mode !== 'always' && account) {
				const signedTx = await account.signTransaction(parseTxParams(tx));
				return await provider.request({
					method: 'eth_sendRawTransaction',
					params: [signedTx],
				});
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
			const tx = params[0];
			const account = accounts.find((a) => a.address === tx.from);
			if (!account) {
				throw new Error('Account not available for signing');
			}
			const signTxParams = parseTxParams(tx);
			if (tx.value) signTxParams.value = BigInt(tx.value);
			return account.signTransaction(signTxParams);
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

	const tevmPendingCountFix: Record<string, (params: any[]) => Promise<any>> | undefined = options?.fixes
		?.tevmPendingCount
		? {
				eth_getTransactionCount: async (params) => {
					const modifiedParam1 = params[1] === 'pending' ? 'latest' : params[1];
					return provider.request({
						method: 'eth_getTransactionCount',
						params: [params[0], modifiedParam1],
					});
				},
			}
		: undefined;

	const handlers: Record<string, (params: any[]) => Promise<any>> = {
		...tevmPendingCountFix,
		...accountHandlers,
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
