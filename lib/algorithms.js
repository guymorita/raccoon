// var redis = require("redis"),
    var async = require('async'),
    config = require('./config.js'),
    _ = require('underscore');

  // the jaccard coefficient outputs an objective measurement of the similar between two objects. in this case, two users. the coefficient
  // is the result of summing the two users likes/dislikes incommon then summing they're likes/dislikes that they disagree on. this sum is
  // then divided by the number of items they both reviewed.
var jaccardCoefficient = function(userId1, userId2, callback){
  // setting all variables to zero
  var similarity = 0,
  finalJaccard = 0,
  ratedInCommon = 0;
  // retrieving a set of all the users likes incommon
  client.sinter([config.className,userId1,'liked'].join(":"),[config.className,userId2,'liked'].join(":"), function(err, results1){
    // retrieving a set of the users dislike incommon
    client.sinter([config.className,userId1,'disliked'].join(":"),[config.className,userId2,'disliked'].join(":"), function(err, results2){
      // retrieving a set of the users like and dislikes that they disagree on
      client.sinter([config.className,userId1,'liked'].join(":"),[config.className,userId2,'disliked'].join(":"), function(err, results3){
        // retrieving a set of the users like and dislikes that they disagree on
        client.sinter([config.className,userId1,'disliked'].join(":"),[config.className,userId2,'liked'].join(":"), function(err, results4){
          // calculating the sum of the similarities minus the sum of the disagreements
          similarity = (results1.length+results2.length-results3.length-results4.length);
          // calculating the number of movies rated incommon
          ratedInCommon = (results1.length+results2.length+results3.length+results4.length);
          // calculating the the modified jaccard score. similarity / num of comparisons made incommon
          finalJaccardScore = similarity / ratedInCommon;
          // calling the callback function passed to jaccard with the new score
          callback(finalJaccardScore);
        });
      });
    });
  });
};

// this function updates the similarity for one user versus all others. at scale this probably needs to be refactored to compare a user
// against clusters of users instead of against all. every comparison will be a value between -1 and 1 representing simliarity.
// -1 is exact opposite, 1 is exactly the same.
exports.updateSimilarityFor = function(userId, cb){
  // turning the userId into a string. depending on the db they might send an object, in which it won't compare properly when comparing
  // to other users
  userId = String(userId);
  // initializing variables
  var similaritySet, userRatedItemIds, itemLiked, itemDisliked, itemLikeDislikeKeys;
  // setting the redis key for the user's similarity set
  similaritySet = [config.className,userId,'similaritySet'].join(":");
  // creating a combined set with the all of a users likes and dislikes
  client.sunion([config.className,userId,'liked'].join(":"),[config.className,userId,'disliked'].join(":"), function(err, userRatedItemIds){
    // if they have rated anything
    if (userRatedItemIds.length > 0){
      // creating a list of redis keys to look up all of the likes and dislikes for a given set of items
      itemLikeDislikeKeys = _.map(userRatedItemIds, function(itemId, key){
        // key for that item being liked
        itemLiked = [config.className, itemId, 'liked'].join(":");
        // key for the item being disliked
        itemDisliked = [config.className, itemId, 'disliked'].join(":");
        // returning an array of those keys
        return [itemLiked, itemDisliked];
      });
    }
    // flattening the array of all the likes/dislikes for the items a user rated
    itemLikeDislikeKeys = _.flatten(itemLikeDislikeKeys);
    // builds one set of all the users who liked and disliked the same items
    client.sunion(itemLikeDislikeKeys, function(err, otherUserIdsWhoRated){
      // running in async parallel, going through the array of user ids who also rated the same things
      async.each(otherUserIdsWhoRated,
        // running a function on each item in the list
        function(otherUserId, callback){
          // if there is only one other user or the other user is the same user
          if (otherUserIdsWhoRated.length === 1 || userId === otherUserId){
            // then call the callback and exciting the similarity check
            callback();
          }
          // if the userid is not the same as the user
          if (userId !== otherUserId){
            // calculate the jaccard coefficient for similarity. it will return a value between -1 and 1 showing the two users
            // similarity
            jaccardCoefficient(userId, otherUserId, function(result) {
              // with the returned similarity score, add it to a sorted set named above
              client.zadd(similaritySet, result, otherUserId, function(err){
                // call the async callback function once finished to indicate that the process is finished
                callback();
              });
            });
          }
        },
        // once all the async comparisons have been made, call the final callback based to the original function
        function(err){
          cb();
        }
      );
    });
  });
};

exports.predictFor = function(userId, itemId, callback){
  userId = String(userId);
  itemId = String(itemId);
  var finalSimilaritySum = 0.0;
  var prediction = 0.0;
  var similaritySet = [config.className, userId, 'similaritySet'].join(':');
  var likedBySet = [config.className, itemId, 'liked'].join(':');
  var dislikedBySet = [config.className, itemId, 'disliked'].join(':');
  exports.similaritySum(similaritySet, likedBySet, function(result1){
    exports.similaritySum(similaritySet, dislikedBySet, function(result2){
      finalSimilaritySum = result1 - result2;
      client.scard(likedBySet, function(err, likedByCount){
        client.scard(dislikedBySet, function(err, dislikedByCount){
          prediction = finalSimilaritySum / parseFloat(likedByCount + dislikedByCount);
          if (isFinite(prediction)){
            callback(prediction);
          } else {
            callback(0.0);
          }
        });
      });
    });
  });
};

exports.similaritySum = function(simSet, compSet, cb){
  var similarSum = 0.0;
  client.smembers(compSet, function(err, userIds){
    async.each(userIds,
      function(userId, callback){
        client.zscore(simSet, userId, function(err, zScore){
          similarSum += parseFloat(zScore);
          callback();
        });
      },
      function(err){
        cb(similarSum);
      }
    );
  });
};

exports.updateRecommendationsFor = function(userId, cb){
  userId = String(userId);
  var setsToUnion = [];
  var scoreMap = [];
  var tempSet = [config.className, userId, 'tempSet'].join(":");
  var tempDiffSet = [config.className, userId, 'tempDiffSet'].join(":");
  var similaritySet = [config.className, userId, 'similaritySet'].join(":");
  var recommendedSet = [config.className, userId, 'recommendedSet'].join(":");
  client.zrevrange(similaritySet, 0, config.nearestNeighbors-1, function(err, mostSimilarUserIds){
    client.zrange(similaritySet, 0, config.nearestNeighbors-1, function(err, leastSimilarUserIds){
      _.each(mostSimilarUserIds, function(id, key){
        setsToUnion.push([config.className,id,'liked'].join(":"));
      });
      if (config.factorLeastSimilarLeastLiked){
        _.each(leastSimilarUserIds, function(id, key){
          setsToUnion.push([config.className,id,'disliked'].join(":"));
        });
      }
      if (setsToUnion.length > 0){
        async.each(setsToUnion,
          function(set, callback){
            client.sunionstore(tempSet, set, function(err){
              callback();
            });
          },
          function(err){
            client.sdiff(tempSet, [config.className,userId,'liked'].join(":"), [config.className,userId,'disliked'].join(":"), function(err, itemIds){
              async.each(itemIds,
                function(itemId, callback){
                  exports.predictFor(userId, itemId, function(score){
                    scoreMap.push([score, itemId]);
                    callback();
                  });
                },
                function(err){
                  async.each(scoreMap,
                    function(scorePair, callback){
                      client.zadd(recommendedSet, scorePair[0], scorePair[1], function(err){
                        callback();
                      });
                    },
                    function(err){
                      client.del(tempSet, function(err){
                        client.zcard(recommendedSet, function(err, length){
                          client.zremrangebyrank(recommendedSet, 0, length-config.numOfRecsStore-1, function(err){
                            cb();
                          });
                        });
                      });
                    }
                  );
                }
              );
            });
          }
        );
      } else {
        cb();
      }
    });
  });
};

// the wilson score is a proxy for 'best rated'. it represents the best finding the best ratio of likes and also eliminating
// outliers. the wilson score is a value between 0 and 1.
exports.updateWilsonScore = function(itemId, callback){
  var scoreBoard = [config.className, 'scoreBoard'].join(":");
  var likedBySet = [config.className, itemId, 'liked'].join(':');
  var dislikedBySet = [config.className, itemId, 'disliked'].join(':');
  var z = 1.96;
  var n, phat, score;
  client.scard(likedBySet, function(err, likedResults){
    client.scard(dislikedBySet, function(err, dislikedResults){
      if ((likedResults + dislikedResults) > 0){
        n = likedResults + dislikedResults;
        phat = likedResults / parseFloat(n);
        try {
          score = (phat + z*z/(2*n) - z*Math.sqrt((phat*(1-phat)+z*z/(4*n))/n))/(1+z*z/n);
        } catch (e) {
          console.log(e.name + ": " + e.message);
          score = 0.0;
        }
        client.zadd(scoreBoard, score, itemId, function(err){
          callback();
        });
      }
    });
  });
};

