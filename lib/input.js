(function() {
  var config = require('./config.js'),
      algo = require('./algorithms.js');

  var updateSequence = function(userId, itemId, callback){
    algo.updateSimilarityFor(userId, function(){
      algo.updateWilsonScore(itemId, function(){
        algo.updateRecommendationsFor(userId, function(){
          callback();
        });
      });
    });
  };

  var Input = {
    liked: function(userId, itemId, callback){
      client.sismember([config.className, itemId, 'liked'].join(":"), userId, function(err, results){
        if (results === 0){
          client.zincrby([config.className, 'mostLiked'].join(":"), 1, itemId);
        }
        client.sadd([config.className, userId,'liked'].join(':'), itemId, function(err){
          client.sadd([config.className, itemId, 'liked'].join(':'), userId, function(err){
            updateSequence(userId, itemId, callback);
          });
        });
      });
    },
    disliked: function(userId, itemId, callback){
      client.sismember([config.className, itemId, 'disliked'].join(":"), userId, function(err, results){
        if (results === 0){
          client.zincrby([config.className, 'mostDisliked'].join(":"), 1, itemId);
        }
        client.sadd([config.className, userId, 'disliked'].join(':'), itemId, function(err){
          client.sadd([config.className, itemId, 'disliked'].join(':'), userId, function(err){
            updateSequence(userId, itemId, callback);
          });
        });
      });
    }
  };

  module.exports = Input;
}).call(this);
