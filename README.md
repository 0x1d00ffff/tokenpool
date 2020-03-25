### Kiwi Token Mining Pool  
Site: [KIWI Token Mining Pool](http://mining.kiwi-token.com/)
A pool for mining [Kiwi Tokens](https://etherscan.io/token/0x2bf91c18cd4ae9c2f2858ef9fe518180f7b5096d)

A fork of [0xBitcoin Tokenpool](https://github.com/0xbitcoin/tokenpool)
(GNU PUBLIC LICENSE)


Windows GPU Miner 1
https://bitbucket.org/LieutenantTofu/cosmic-v3/downloads/COSMiC-v4.1.1-MultiGPU-TMP.zip

Windows GPU Miner 2
 https://github.com/mining-visualizer/MVis-tokenminer/releases

 Windows GPU Miner 3
 https://github.com/lwYeo/SoliditySHA3MinerUI/releases/tag/1.0.2

 Linux GPU Miner
 https://github.com/lwYeo/SoliditySHA3Miner/releases


### BASIC SETUP  (needs Node 8.10)
1. npm install -g node-gyp
1.1. sudo apt-get install build-essential

You may need to do.. (depending on operating system and python version)
1.2.sudo apt-get install python2.7
1.3.npm config set python python2.7

2. npm install

3. rename 'sample.account.config.js' to 'account.config.js' and fill it with the pool's ethereum account data (make two new accounts, one for minting one for payments and fill both with a small amount of ETH)

4. install redis-server and start it with 'npm run redis' in another screen ('screen -S redis', ctrl+shift+A+D)

5. Edit pool.config.js to your tastes (optional)

6. Deploy two contracts (see the section below) and add their addresses to app/assets/contracts/DeployedContractInfo.json

7. Edit the website files in /app  to change the look of the website (optional)
8. Install mongodb, make sure it is running as a daemon service
9. 'npm run webpack'  #(to build the website files)
10. 'npm run server' #(or 'npm run server test 'for Ropsten test mode)



### CONFIGURING  - set up  account.config.js and pool.config.js

##### pool.config.js

```
var poolconfig = {
  minimumShareDifficulty: 5000,   //lowest miner share difficulty
  maximumShareDifficulty: 10000    //highest miner share difficulty
  solutionGasPriceWei: 10,   //ether paid by the pool for each mint
  transferGasPriceWei: 6,   //ether paid by the pool for each payment
  poolTokenFee: 5,     //percent of tokens the pool keeps for itself
  communityTokenFee: 2,   //percent of tokens the pool pledges to donate
  minBalanceForTransfer: 1500000000,   
  payoutWalletMinimum: 100000000000,
  allowCustomVardiff: false,
  rebroadcastPaymentWaitBlocks: 500,
  minPaymentsInBatch: 5,
  //web3provider: "http://127.0.0.1:8545"   //point at Geth or remove to use Infura
}
```

## Deploying Contracts
####     [found in app/assets/contracts/deployedContractInfo.json]
EDIT THIS FILE!!!

* Replace 'mintforwarder' address with your own deployed version of the contract !!! NOTE: make sure that in the 'mintforwarder' contract, the payoutsWallet address is set to the address of the 'batch payments' contract
* Replace 'batch payments' contract address as well !!! your own deployed contract !! NOTE: make sure the 'batch payments' contract is owned by the 'payments' account. If it is not you will need to call transferOwnership on the 'batch payments' contract to switch ownership.

Here are examples of these contracts to copy and paste the code and deploy using https://remix.ethereum.org:

Mint Helper (Mint Forwarder) Contract Code:
https://etherscan.io/address/0xeabe48908503b7efb090f35595fb8d1a4d55bd66#code

Batched Payments Contract Code:
https://etherscan.io/address/0xebf6245689194a6e43096551567827c6726ede0b#code


## HOW TO TEST
1. Point a EIP918 tokenminer (https://github.com/0xbitcoin/0xbitcoin-miner) at your pool using http://localhost:8080   (make sure firewall allows this port)
2. Start the server with 'npm run webpack' and 'npm run server test' to put it into ropsten mode
3. View website interface at http://localhost:3000 (Feel free to set up nginx/apache to serve the static files in /public)

You should see that the miner is able to successfully submit shares to the pool when the share difficulty is set to a low value such as 100 and the pool is in 'ropsten mode'.  Then you can run the pool on mainnet using 'npm run server'.


## Installing MongoDB

Digitalocean guide:
https://www.digitalocean.com/community/tutorials/how-to-install-mongodb-on-ubuntu-16-04#step-3-%E2%80%94-adjusting-the-firewall-(optional)

 - Mongo is used to store data related to miner shares, balances, and payments


## Installing Redis  
  1. sudo apt-get install redis
  2. sudo service redis-server start

   - Redis will serve/connect at localhost:6379 by default - the pool will use this port
   - Redis is only used for frontend non-critical data, but is required for this web application


## Task Commands Example
node util/reset_all_miner_reward_data.js


## TODO / BUGS
 - Account Shares page often shows all miners with share % of NaN
 - Account Shares list only shows some miners(?) possibly those with recent shares
 - All payment transactions fail and revert
   - Account Shares list shows Total Tokens Earned as 0. Possibly due to reverted payouts
 - Add input sanitization to api endpoints in peer-interface.js. API calls from a miner
   with a malformed address should return error.
 - Payment batching (batchMinedPayments()) seems to be set up to occur every 30 seconds,
   but it also appears to create a new batch whenever a balance payment is available. Need
   to do some more checks/testing to see if this is desirable, if it should be slowed
   down, or if it should be simply called by a different periodic task.
 - Switch to geth and modify COLLECT_TOKEN_DATA_PERIOD in token-interface.js to a much 
   lower number. Once every 30 seconds currently - is that correct? It seems the pool 
   would not work well if going that slow.
 - If vardiff is not used, disable updateVariableDifficultyPeriod task. Alternatively
   just re-enable vardiff.
 - cleanRedisData should be a periodic task. It removes extra entries from redis lists
   that would otherwise grow unbounded. Test/trace code to figure out why it is not
   configured as a periodic task.
 - The first version of this code only used a single eth wallet for mints and payouts,
   so parts of the code can be simplified. For example getTransactionStatistics can
   be simplified along with the logic at the beginning of broadcastQueuedMintTransactions.
 - Every share is validated at least twice. See TODO at the top of handlePeerShareSubmit
 - Vardiff adjustment is broken because handleValidShare is using
   minerData.lastSubmittedSolutionTime (which is always null) to fill out share.timeToFind. This causes share.timeToFind=0 to be set for all shares - so getAverageSolutionTime
   skips over all shares and returns null. 

## FORMATTING
 - run `npm run format`

## DATABASE INFO
This is a list of various database keys I have seen while looking through the
code. Note this is not a complete list and there may be duplicates.

#### Mongo DB Keys
balance_payment
payment_batch
shares_data_downcase
miner_data_downcase

#### Redis Keys - all strings, some are hash keys that are followed by one or more types of data
challengeNumber
ethBlockNumber
miningTarget
miningDifficulty
queued_mint_transactions
queued_payment_transactions
lost_transactions_list
active_transactions
active_transactions_list
queuedTxCount
pendingTxCount
minedTxCount
successTxCount
queuedMintsCount
queuedPaymentsCount
pendingMintsCount
pendingPaymentsCount
successTxCount
totalPoolFeeTokens
totalCommunityFeeTokens
recent_challenges
unconfirmed_submitted_solution_tx
balance_transfers:0xLOWERCASEETHEREUMADDRESSHERE
balance_transfer
total_pool_hashrate
invalid_share
miner_submitted_share:0xLOWERCASEETHEREUMADDRESSHERE
miner_invalid_share:0xLOWERCASEETHEREUMADDRESSHERE
submitted_share
queued_shares_list
unconfirmed_submitted_solution_tx
balance_transfer, paymentId
queued_replacement, balancePaymentId
submitted_solutions_list
submitted_solution_tx
totalPoolFeeTokens
totalCommunityFeeTokens
shares_data_downcase
miner_data_downcase
queued_shares_list
balance_payments
balance_transfer
balance_transfer, transferId
balance_transfer:0xLOWERCASEETHEREUMADDRESSHERE
balance_transfers:0xLOWERCASEETHEREUMADDRESSHERE
balance_payment
balance_payment, paymentId
payment_tx, paymentId
balance_payments:0xLOWERCASEETHEREUMADDRESSHERE
miner_submitted_share:0xLOWERCASEETHEREUMADDRESSHERE
active_transactions_list
queued_payment_transactions
active_transactions_list
queued_replacement_payment
unconfirmed_broadcasted_payment
submitted_shares_list
miner_data_downcase, minerEthAddress


