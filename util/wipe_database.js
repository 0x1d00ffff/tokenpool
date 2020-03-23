/* wipe payments, shares, and miners from mongo database */


var redisInterface = require('../lib/redis-interface')
var mongoInterface = require('../lib/mongo-interface')



init();

async function init()
{
   //await redisInterface.init()
   await mongoInterface.init()


   //var balance_xfers = await redisInterface.deleteHashArrayInRedis('balance_payment')
   //var payment_batches = mongoInterface.findAll('balance_payment', {});
   var payment_batches = await mongoInterface.findAll('payment_batch',{});
   console.log(payment_batches.length, "payment batches. deleting...");
   for(var element of payment_batches) {
       await mongoInterface.deleteOne('payment_batch', element);
   }
   var balance_payments = await mongoInterface.findAll('balance_payment',{});
   console.log(balance_payments.length, "balance payments. deleting...");
   for(var element of balance_payments) {
       await mongoInterface.deleteOne('balance_payment', element);
   }
   var shares_data_downcase = await mongoInterface.findAll('shares_data_downcase',{});
   console.log(shares_data_downcase.length, "shares. deleting...");
   for(var element of shares_data_downcase) {
       await mongoInterface.deleteOne('shares_data_downcase', element);
   }
   var miner_data_downcase = await mongoInterface.findAll('miner_data_downcase',{});
   console.log(miner_data_downcase.length, "miners. deleting...");
   for(var element of miner_data_downcase) {
       await mongoInterface.deleteOne('miner_data_downcase', element);
   }
   console.log('done.');
}
