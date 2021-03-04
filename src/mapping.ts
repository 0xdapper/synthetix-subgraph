// The latest Synthetix and event invocations
import { Synthetix as SNX, Transfer as SNXTransferEvent } from '../generated/Synthetix/Synthetix';

import { AddressResolver } from '../generated/Synthetix/AddressResolver';

import { sUSD32 } from './helpers';

// SynthetixState has not changed ABI since deployment
import { SynthetixState } from '../generated/Synthetix/SynthetixState';

import { TargetUpdated as TargetUpdatedEvent } from '../generated/ProxySynthetix/Proxy';
import { Vested as VestedEvent, RewardEscrow } from '../generated/RewardEscrow/RewardEscrow';

import {
  Synth,
  Transfer as SynthTransferEvent,
  Issued as IssuedEvent,
  Burned as BurnedEvent,
} from '../generated/SynthsUSD/Synth';
import { FeesClaimed as FeesClaimedEvent } from '../generated/FeePool/FeePool';

import {
  Synthetix,
  Transfer,
  Issued,
  Burned,
  Issuer,
  SNXHolder,
  DebtSnapshot,
  SynthHolder,
  RewardEscrowHolder,
  FeesClaimed,
  TotalActiveStaker,
  TotalDailyActiveStaker,
  ActiveStaker,
} from '../generated/schema';

import { store, BigInt, Address, ethereum, Bytes, log } from '@graphprotocol/graph-ts';

import { strToBytes } from './helpers';

import { handleExchangeEntrySettled, handleExchangeEntryAppended, handleExchangeTracking } from './exchanger-mapping';
export { handleExchangeEntrySettled, handleExchangeEntryAppended, handleExchangeTracking };

import { handleRatesUpdated, handleAggregatorAnswerUpdated } from './rates-mapping';
export { handleRatesUpdated, handleAggregatorAnswerUpdated };

import { handleExchangeReclaim, handleExchangeRebate, handleSynthExchange } from './exchanges-mapping';
export { handleExchangeReclaim, handleExchangeRebate, handleSynthExchange };

let contracts = new Map<string, string>();

// TODO update these hardcoded contracts
contracts.set('escrow', '0x971e78e0c92392a4e39099835cf7e6ab535b2227');
contracts.set('rewardEscrow', '0xb671f2210b1f6621a2607ea63e6b2dc3e2464d1f');

function getMetadata(): Synthetix {
  let synthetix = Synthetix.load('1');

  if (synthetix == null) {
    synthetix = new Synthetix('1');
    synthetix.issuers = BigInt.fromI32(0);
    synthetix.snxHolders = BigInt.fromI32(0);
    synthetix.save();
  }

  return synthetix as Synthetix;
}

function incrementMetadata(field: string): void {
  let metadata = getMetadata();
  if (field == 'issuers') {
    metadata.issuers = metadata.issuers.plus(BigInt.fromI32(1));
  } else if (field == 'snxHolders') {
    metadata.snxHolders = metadata.snxHolders.plus(BigInt.fromI32(1));
  }
  metadata.save();
}

function decrementMetadata(field: string): void {
  let metadata = getMetadata();
  if (field == 'issuers') {
    metadata.issuers = metadata.issuers.minus(BigInt.fromI32(1));
  } else if (field == 'snxHolders') {
    metadata.snxHolders = metadata.snxHolders.minus(BigInt.fromI32(1));
  }
  metadata.save();
}

function trackIssuer(account: Address): void {
  let existingIssuer = Issuer.load(account.toHex());
  if (existingIssuer == null) {
    incrementMetadata('issuers');
    let issuer = new Issuer(account.toHex());
    issuer.save();
  }
}

function trackSNXHolder(
  snxContract: Address,
  account: Address,
  block: ethereum.Block,
  txn: ethereum.Transaction,
): void {
  let holder = account.toHex();
  // ignore escrow accounts
  if (contracts.get('escrow') == holder || contracts.get('rewardEscrow') == holder) {
    return;
  }
  let existingSNXHolder = SNXHolder.load(holder);
  let snxHolder = new SNXHolder(holder);
  snxHolder.block = block.number;
  snxHolder.timestamp = block.timestamp;

  let synthetix = SNX.bind(snxContract);
  snxHolder.balanceOf = synthetix.balanceOf(account);
  snxHolder.collateral = synthetix.collateral(account);

  // Check transferable because it will be null when rates are stale
  let transferableTry = synthetix.try_transferableSynthetix(account);
  if (!transferableTry.reverted) {
    snxHolder.transferable = transferableTry.value;
  }
  let resolverTry = synthetix.try_resolver();
  if (resolverTry.reverted) {
    log.debug('Skipping SNX holder tracking: No resolver property from SNX holder from hash: {}, block: {}', [
      txn.hash.toHex(),
      block.number.toString(),
    ]);
    return;
  }
  let resolverAddress = resolverTry.value;
  let resolver = AddressResolver.bind(resolverAddress);
  let synthetixState = SynthetixState.bind(resolver.getAddress(strToBytes('SynthetixState', 32)));
  let issuanceData = synthetixState.issuanceData(account);
  snxHolder.initialDebtOwnership = issuanceData.value0;

  // Note: due to limitations with how The Graph deals with chain reorgs, we need to try_debtLedger
  /*
        From Jannis at The Graph:
        graph-node currently makes contract calls by block number (that used to be the only way
        to do it and we haven't switched to calling by block hash yet). If there is a reorg,
        this may lead to making calls against a different block than expected.
        If the subgraph doesn't fail on such a call, the resulting data should be reverted as
        soon as the reorg is detected (e.g. when processing the next block). It can temporarily
        cause inconsistent data until that happens.
        However, if such a call fails (e.g. you're expecting an array to have grown by one but
        in the fork of the chain it hasn't and the call doesn't use try_), then this can cause
        the subgraph to fail.
        Here's what happens during a reorg:
        - Block 0xa (block number 100) is being processed.
        - A handler makes a try_debtLedger call against block number 100 but hits block 0xb instead of 0xa.
        - The result gets written to the store marked with block 0xa (because that's what we're processing).
        - The reorg is detected: block number 100 is no longer 0xa, it's 0xb
        - The changes made for 0xa (including the inconsistent/incorrect try_debtLedger result) are reverted.
        - Block 0xb is processed. The handler now makes the try_debtLedger call against 100 -> 0xb and the correct data is being returned
    */

  let debtLedgerTry = synthetixState.try_debtLedger(issuanceData.value1);
  if (!debtLedgerTry.reverted) {
    snxHolder.debtEntryAtIndex = debtLedgerTry.value;
  }

  if (
    (existingSNXHolder == null && snxHolder.balanceOf > BigInt.fromI32(0)) ||
    (existingSNXHolder != null &&
      existingSNXHolder.balanceOf == BigInt.fromI32(0) &&
      snxHolder.balanceOf > BigInt.fromI32(0))
  ) {
    incrementMetadata('snxHolders');
  } else if (
    existingSNXHolder != null &&
    existingSNXHolder.balanceOf > BigInt.fromI32(0) &&
    snxHolder.balanceOf == BigInt.fromI32(0)
  ) {
    decrementMetadata('snxHolders');
  }

  snxHolder.save();
}

function trackDebtSnapshot(event: ethereum.Event): void {
  let snxContract = event.transaction.to as Address;
  let account = event.transaction.from;

  // ignore escrow accounts
  if (contracts.get('escrow') == account.toHex() || contracts.get('rewardEscrow') == account.toHex()) {
    return;
  }

  let entity = new DebtSnapshot(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.block = event.block.number;
  entity.timestamp = event.block.timestamp;
  entity.account = account;

  let synthetix = SNX.bind(snxContract);
  entity.balanceOf = synthetix.balanceOf(account);
  entity.collateral = synthetix.collateral(account);
  entity.debtBalanceOf = synthetix.debtBalanceOf(account, sUSD32);

  entity.save();
}

export function handleTransferSNX(event: SNXTransferEvent): void {
  let entity = new Transfer(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.source = 'SNX';
  entity.from = event.params.from;
  entity.to = event.params.to;
  entity.value = event.params.value;
  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.save();

  trackSNXHolder(event.address, event.params.from, event.block, event.transaction);
  trackSNXHolder(event.address, event.params.to, event.block, event.transaction);
}

function trackSynthHolder(contract: Synth, source: string, account: Address): void {
  let entityID = account.toHex() + '-' + source;
  let entity = SynthHolder.load(entityID);
  if (entity == null) {
    entity = new SynthHolder(entityID);
  }
  entity.synth = source;
  entity.balanceOf = contract.balanceOf(account);
  entity.save();
}

export function handleTransferSynth(event: SynthTransferEvent): void {
  let contract = Synth.bind(event.address);
  let entity = new Transfer(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.source = 'sUSD';
  let currencyKeyTry = contract.try_currencyKey();
  if (!currencyKeyTry.reverted) {
    entity.source = currencyKeyTry.value.toString();
  }
  entity.from = event.params.from;
  entity.to = event.params.to;
  entity.value = event.params.value;
  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.save();

  trackSynthHolder(contract, entity.source, event.params.from);
  trackSynthHolder(contract, entity.source, event.params.to);
}

/**
 * Handle reward vest events so that we know which addresses have rewards, and
 * to recalculate SNX Holders staking details.
 */
// Note: we use VestedEvent here even though is also handles VestingEntryCreated (they share the same signature)
export function handleRewardVestEvent(event: VestedEvent): void {
  let entity = new RewardEscrowHolder(event.params.beneficiary.toHex());
  let contract = RewardEscrow.bind(event.address);
  entity.balanceOf = contract.balanceOf(event.params.beneficiary);
  entity.vestedBalanceOf = contract.totalVestedAccountBalance(event.params.beneficiary);
  entity.save();
  // now track the SNX holder as this action can impact their collateral
  let synthetixAddress = contract.synthetix();
  trackSNXHolder(synthetixAddress, event.params.beneficiary, event.block, event.transaction);
}

export function handleIssuedSynths(event: IssuedEvent): void {
  // We need to figure out if this was generated from a call to Synthetix.issueSynths, issueMaxSynths or any earlier
  // versions.

  let functions = new Map<string, string>();

  functions.set('0xaf086c7e', 'issueMaxSynths()');
  functions.set('0x320223db', 'issueMaxSynthsOnBehalf(address)');
  functions.set('0x8a290014', 'issueSynths(uint256)');
  functions.set('0xe8e09b8b', 'issueSynthsOnBehalf(address,uint256');

  // Prior to Vega we had the currency key option in issuance
  functions.set('0xef7fae7c', 'issueMaxSynths(bytes32)'); // legacy
  functions.set('0x0ee54a1d', 'issueSynths(bytes32,uint256)'); // legacy

  // Prior to Sirius release, we had currency keys using bytes4
  functions.set('0x9ff8c63f', 'issueMaxSynths(bytes4)'); // legacy
  functions.set('0x49755b9e', 'issueSynths(bytes4,uint256)'); // legacy

  // Prior to v2
  functions.set('0xda5341a8', 'issueMaxNomins()'); // legacy
  functions.set('0x187cba25', 'issueNomins(uint256)'); // legacy

  // so take the first four bytes of input
  let input = event.transaction.input.subarray(0, 4) as Bytes;

  // and for any function calls that don't match our mapping, we ignore them
  if (!functions.has(input.toHexString())) {
    log.debug('Ignoring Issued event with input: {}, hash: {}, address: {}', [
      event.transaction.input.toHexString(),
      event.transaction.hash.toHex(),
      event.address.toHexString(),
    ]);
    return;
  }

  let entity = new Issued(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.account = event.transaction.from;

  // Note: this amount isn't in sUSD for sETH or sBTC issuance prior to Vega
  entity.value = event.params.value;

  let synth = Synth.bind(event.address);
  let currencyKeyTry = synth.try_currencyKey();
  if (!currencyKeyTry.reverted) {
    entity.source = currencyKeyTry.value.toString();
  } else {
    entity.source = 'sUSD';
  }

  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  entity.save();

  trackActiveStakers(event, false);

  // track this issuer for reference
  trackIssuer(event.transaction.from);

  // update SNX holder details
  trackSNXHolder(event.transaction.to as Address, event.transaction.from, event.block, event.transaction);

  // now update SNXHolder to increment the number of claims
  let snxHolder = SNXHolder.load(entity.account.toHexString());
  if (snxHolder != null) {
    if (snxHolder.mints == null) {
      snxHolder.mints = BigInt.fromI32(0);
    }
    snxHolder.mints = snxHolder.mints.plus(BigInt.fromI32(1));
    snxHolder.save();
  }

  // update Debt snapshot history
  trackDebtSnapshot(event);
}

export function handleBurnedSynths(event: BurnedEvent): void {
  // We need to figure out if this was generated from a call to Synthetix.burnSynths, burnSynthsToTarget or any earlier
  // versions.

  let functions = new Map<string, string>();
  functions.set('0x295da87d', 'burnSynths(uint256)');
  functions.set('0xc2bf3880', 'burnSynthsOnBehalf(address,uint256');
  functions.set('0x9741fb22', 'burnSynthsToTarget()');
  functions.set('0x2c955fa7', 'burnSynthsToTargetOnBehalf(address)');

  // Prior to Vega we had the currency key option in issuance
  functions.set('0xea168b62', 'burnSynths(bytes32,uint256)');

  // Prior to Sirius release, we had currency keys using bytes4
  functions.set('0xaf023335', 'burnSynths(bytes4,uint256)');

  // Prior to v2 (i.e. in Havven times)
  functions.set('0x3253ccdf', 'burnNomins(uint256');

  // so take the first four bytes of input
  let input = event.transaction.input.subarray(0, 4) as Bytes;

  // and for any function calls that don't match our mapping, we ignore them
  if (!functions.has(input.toHexString())) {
    log.debug('Ignoring Burned event with input: {}, hash: {}, address: {}', [
      event.transaction.input.toHexString(),
      event.transaction.hash.toHex(),
      event.address.toHexString(),
    ]);
    return;
  }

  let entity = new Burned(event.transaction.hash.toHex() + '-' + event.logIndex.toString());
  entity.account = event.transaction.from;

  // Note: this amount isn't in sUSD for sETH or sBTC issuance prior to Vega
  entity.value = event.params.value;

  let synth = Synth.bind(event.address);
  let currencyKeyTry = synth.try_currencyKey();
  if (!currencyKeyTry.reverted) {
    entity.source = currencyKeyTry.value.toString();
  } else {
    entity.source = 'sUSD';
  }

  entity.timestamp = event.block.timestamp;
  entity.block = event.block.number;
  entity.gasPrice = event.transaction.gasPrice;
  entity.save();

  trackActiveStakers(event, true);

  // update SNX holder details
  trackSNXHolder(event.transaction.to as Address, event.transaction.from, event.block, event.transaction);
  // update Debt snapshot history
  trackDebtSnapshot(event);
}

export function handleFeesClaimed(event: FeesClaimedEvent): void {
  let entity = new FeesClaimed(event.transaction.hash.toHex() + '-' + event.logIndex.toString());

  entity.account = event.params.account;
  entity.rewards = event.params.snxRewards;
  entity.value = event.params.sUSDAmount;

  entity.block = event.block.number;
  entity.timestamp = event.block.timestamp;

  entity.save();

  // now update SNXHolder to increment the number of claims
  let snxHolder = SNXHolder.load(entity.account.toHexString());
  if (snxHolder != null) {
    if (snxHolder.claims == null) {
      snxHolder.claims = BigInt.fromI32(0);
    }
    snxHolder.claims = snxHolder.claims.plus(BigInt.fromI32(1));
    snxHolder.save();
  }
}

function trackActiveStakers(event: ethereum.Event, isBurn: boolean): void {
  let account = event.transaction.from;
  let timestamp = event.block.timestamp;
  let snxContract = event.transaction.to as Address;
  let accountDebtBalance = BigInt.fromI32(0);

  let synthetix = SNX.bind(snxContract);
  accountDebtBalance = synthetix.debtBalanceOf(account, sUSD32);

  let dayID = timestamp.toI32() / 86400;

  let totalActiveStaker = TotalActiveStaker.load('1');
  let activeStaker = ActiveStaker.load(account.toHex());

  if (totalActiveStaker == null) {
    totalActiveStaker = loadTotalActiveStaker();
  }

  // You are burning and have been counted before as active and have no debt balance
  // we reduce the count from the total and remove the active staker entity
  if (isBurn && activeStaker != null && accountDebtBalance == BigInt.fromI32(0)) {
    totalActiveStaker.count = totalActiveStaker.count.minus(BigInt.fromI32(1));
    totalActiveStaker.save();
    store.remove('ActiveStaker', account.toHex());
    // else if you are minting and have not been accounted for as being active, add one
    // and create a new active staker entity
  } else if (!isBurn && activeStaker == null) {
    activeStaker = new ActiveStaker(account.toHex());
    activeStaker.save();
    totalActiveStaker.count = totalActiveStaker.count.plus(BigInt.fromI32(1));
    totalActiveStaker.save();
  }

  // Once a day we stor the total number of active stakers in an entity that is easy to query for charts
  let totalDailyActiveStaker = TotalDailyActiveStaker.load(dayID.toString());
  if (totalDailyActiveStaker == null) {
    updateTotalDailyActiveStaker(dayID.toString(), totalActiveStaker.count);
  }
}

function loadTotalActiveStaker(): TotalActiveStaker {
  let newActiveStaker = new TotalActiveStaker('1');
  newActiveStaker.count = BigInt.fromI32(0);
  return newActiveStaker;
}

function updateTotalDailyActiveStaker(id: string, count: BigInt): void {
  let newTotalDailyActiveStaker = new TotalDailyActiveStaker(id);
  newTotalDailyActiveStaker.count = count;
  newTotalDailyActiveStaker.save();
}
