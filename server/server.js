var bcrypt = require('bcryptjs');
var bodyParser = require('body-parser');
var cors = require('cors');
var express = require('express');
var jwt = require('jwt-simple');
var moment = require('moment');
var mongoose = require('mongoose');
var path = require('path');
var request = require('request');

var app = express();

var config = require('./config');

var User = mongoose.model('User', new mongoose.Schema({
  instagramId: { type: String, index: true },
  email: { type: String, unique: true, lowercase: true },
  password: { type: String, select: false },
  username: String,
  fullName: String,
  picture: String,
  accessToken: String
}));

mongoose.connect(config.db);

app.set('port', process.env.PORT || 3000);
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Creates a new JWT encode based on a user
 * @param user
 * @returns {String|*}
 */
function createToken(user) {
  var payload = {
    exp: moment().add(14, 'days').unix(),
    iat: moment().unix(),
    sub: user._id
  };

  return jwt.encode(payload, config.tokenSecret);
}

/**
 * Verifies if a user is authenticated using JWT Token
 *
 * @param req
 * @param res
 * @param next
 * @returns {*}
 */
function isAuthenticated(req, res, next) {
  if (!(req.headers && req.headers.authorization))
    return res.status(400).send({ message: 'You did not provide a JSON Web Token in the Authorization header.' });

  var header = req.headers.authorization.split(' ');
  var token = header[1];
  var payload = jwt.decode(token, config.tokenSecret);
  var now = moment().unix();

  if (now > payload.exp)
    return res.status(401).send({ message: 'Token has expired' });

  User.findById(payload.sub, function (err, user) {
    if (!user)
      return res.status(400).send({ message: 'User no longer exists.' });

    req.user = user;

    next();
  });

}

app.post('/auth/signup', function (req, res) {
  User.findOne({ email: req.body.email }, function (err, existingUser) {
    if (existingUser)
      return res.status(409).send({ message: 'Email is already taken' });

    var user = new User({
      email: req.body.email,
      password: req.body.password
    });

    bcrypt.getSalt(10, function (err, salt) {
      bcrypt.hash(user.password, salt, function (err, hash) {
        user.password = hash;

        user.save(function () {
          var token = createToken(user);
          res.send({ token: token, user: user });
        });
      });
    });

  });
});

app.post('/auth/login', function (req, res) {
  User.findOne({ email: req.body.email }, '+password', function (err, user) {
    if (!user)
      return res.status(401).send({ message: { email: 'Incorrect email' } });

    bcrypt.compare(req.body.password, user.password, function (err, isMatch) {
      if (!isMatch)
        return res.status(401).send({ message: { password: 'Incorrect password' } });

      user = user.toObject();
      delete user.password;

      var token = createToken(user);
      res.send({ token: token, user: user });
    });
  });
});

app.post('/auth/instagram', function (req, res) {
  var accessTokenUrl = 'https://api.instagram.com/oauth/access_token';

  var params = {
    client_id: req.body.clientId,
    redirect_uri: req.body.redirectUri,
    client_secret: config.clientSecret,
    code: req.body.code,
    grant_type: 'authorization_code'
  };

  // Step 1: Exchange authorization code for access token
  request.post({ url: accessTokenUrl, form: params, json: true }, function (e, r, body) {
    if (req.headers.authorization) {
      // Step 2a. Link user accounts
      User.findOne({ instagramId: body.user.id }, function (err, existingUser) {

        var token = req.headers.authorization.split(' ');
        var payload = jwt.decode(token, config.tokenSecret);

        User.findById(payload.sub, '+password', function (err, localUser) {
          if (!localUser)
            return res.status(400).send({ message: 'User not found.' });

          if (existingUser) {
            // Merge two accounts
            existingUser.email = localUser.email;
            existingUser.password = localUser.password;

            localUser.remove();

            existingUser.save(function () {
              return res.send({ token: createToken(existingUser), user: existingUser });
            });

          } else {
            // Link current email account with the Instagram profile information
            localUser.instagramId = body.user.id;
            localUser.username = body.user.username;
            localUser.fullName = body.user.full_name;
            localUser.picture = body.user.profile_picture;
            localUser.accessToken = body.access_token;

            localUser.save(function () {
              return res.send({ token: createToken(localUser), user: localUser });
            });
          }
        });

      });

    } else {
      // Step 2b. Create a new user account or return an existing one
      User.findOne({ instagramId: body.user.id }, function (err, existingUser) {
        if (existingUser)
          return res.send({ token: createToken(existingUser), user: existingUser });

        var user = new User({
          instagramId: body.user.id,
          username: body.user.username,
          fullName: body.user.full_name,
          picture: body.user.profile_picture,
          accessToken: body.access_token
        });

        user.save(function () {
          return res.send({ token: createToken(user), user: user });
        })

      });
    }
  });

});

app.listen(app.get('port'), function () {
  console.log('Express server listening on port', app.get('port'));
});
