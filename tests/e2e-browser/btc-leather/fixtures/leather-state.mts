/**
 * A signed-in Leather wallet state, seeded into `chrome.storage` so the e2e skips onboarding — the
 * same mechanism Leather's own suite uses (`signInWithTestAccount`).
 *
 * `defaultWalletState` and the session key below are copied verbatim from Leather's
 * `apps/extension/tests/page-object-models/onboarding.page.ts` at `@leather.io/extension-v6.115.0`
 * (MIT License, Copyright (c) 2023 Leather Wallet LLC). They are the publicly documented test
 * mnemonic ("abandon ×11 cactus") encrypted under Leather's test password — no real funds, ever.
 * `_persist.version` ties them to that release: re-copy them when bumping LEATHER_VERSION.
 */

const testFingerprint = 'e87a850b';
function defaultWalletState() {
  return {
    accounts: {
      ids: [`${testFingerprint}/0`],
      entities: {
        [`${testFingerprint}/0`]: { id: `${testFingerprint}/0` },
      },
    },
    active: {
      account: {
        fingerprint: testFingerprint,
        accountIndex: 0,
      },
      activePolicyId: null,
    },
    chains: {
      stx: {
        [testFingerprint]: {
          highestAccountIndex: 10,
          currentAccountStacksDescriptor: '',
        },
      },
    },
    appPermissions: {
      entities: {},
      ids: [],
    },
    wallets: {
      ids: [testFingerprint],
      entities: {
        [testFingerprint]: {
          fingerprint: testFingerprint,
          name: 'Wallet 1',
          type: 'software',
          createdOn: null,
        },
      },
    },
    softwareKeys: {
      salt: 'a086b877fc757a4daa7c6343d2861c05',
      ids: [testFingerprint],
      entities: {
        [testFingerprint]: {
          type: 'software',
          id: testFingerprint,
          encryptedSecretKey:
            'ff735c244c72e1c7f7dc411b240ce6e30f87a43106cd1c87a77d3a6f80679176558ce2e73d1a089d6a83d8764b31d9d9043a6f79ca1104fb8238a6ae4f1e063bc1f1c3ba99c4c4e8b38d871963a7e3d8a0a4ed5e6525ec6702d9074dd9ee376c',
        },
      },
    },
    keychains: {
      entities: {},
      ids: [],
    },
    networks: { ids: [], entities: {}, currentNetworkId: 'mainnet' },
    policy: { entities: {}, ids: [] },
    settings: {
      userSelectedTheme: 'system',
      dismissedMessages: [],
      dismissedPromoIndexes: [],
      seenFeatureIntros: [],
      discardedInscriptions: [],
      isNotificationsEnabled: true,
    },
    manageTokens: { entities: {}, ids: [] },
    _persist: { version: 4, rehydrated: true },
  };
}

/** The session encryption key matching `defaultWalletState`'s `softwareKeys`. */
export const TEST_ENCRYPTION_KEY =
  'd904f412b8d116540017c302f3f7033813c95902af5a067c7befcc34fa5e5290709f157f80548603a1e4f8edc2c0d5d7';

/**
 * The default state with one custom network, id `regtest`, whose Bitcoin API is `esploraUrl`
 * (Leather reads custom networks through Esplora). The id is the one the page passes as
 * `network`, so every request resolves to it. Leather networks also carry a Stacks API; this one
 * points at a closed port, so Leather's Stacks polling fails fast instead of reaching anything.
 */
export function walletState(esploraUrl: string): object {
  return {
    ...defaultWalletState(),
    networks: {
      ids: ['regtest'],
      entities: {
        regtest: {
          id: 'regtest',
          name: 'e2e regtest',
          chainId: 2147483648,
          url: 'http://127.0.0.1:9',
          bitcoinNetwork: 'regtest',
          bitcoinUrl: esploraUrl,
        },
      },
      currentNetworkId: 'regtest',
    },
  };
}
