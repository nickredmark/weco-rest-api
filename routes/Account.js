require('dotenv').config()
const config = require('../Config')
const express = require('express')
const router = express.Router()
const sequelize = require('sequelize')
const sgMail = require('@sendgrid/mail')
sgMail.setApiKey(process.env.SENDGRID_API_KEY)
const authenticateToken = require('../middleware/authenticateToken')
const { Holon, User, Notification, HolonUser, UserPost } = require('../models')
const { totalUserPosts } = require('../GlobalConstants')

// GET
router.get('/account-data', authenticateToken, (req, res) => {
    const accountId = req.user.id
    User.findOne({ 
      where: { id: accountId },
      attributes: [
        'id', 'name', 'handle', 'bio', 'email', 'flagImagePath',
        [sequelize.literal(
          `(SELECT COUNT(*) FROM Notifications AS Notification WHERE Notification.ownerId = User.id AND Notification.seen = false)`
          ),'unseenNotifications'
        ]
      ],
      include: [
        {
          model: Holon,
          as: 'FollowedHolons',
          where: { state: 'active' },
          required: false,
          attributes: ['id', 'handle', 'name', 'flagImagePath'],
          through: { where: { relationship: 'follower', state: 'active' }, attributes: [] }
        },
        {
          model: Holon,
          as: 'ModeratedHolons',
          attributes: ['id', 'handle', 'name', 'flagImagePath'],
          through: { where: { relationship: 'moderator', state: 'active' }, attributes: [] }
        }
      ]
    })
    .then(user => res.send(user))
})

router.get('/account-notifications', authenticateToken, (req, res) => {
    const accountId = req.user.id

    Notification
        .findAll({
            where: { ownerId: accountId },
            order: [['createdAt', 'DESC']],
            include: [
                {
                    model: User,
                    as: 'triggerUser',
                    attributes: ['id', 'handle', 'name', 'flagImagePath'],
                },
                {
                    model: Holon,
                    as: 'triggerSpace',
                    attributes: ['id', 'handle', 'name', 'flagImagePath'],
                },
                {
                    model: Holon,
                    as: 'secondarySpace',
                    attributes: ['id', 'handle', 'name', 'flagImagePath'],
                }
            ]
        })
        .then(notifications => res.send(notifications))
})

// POST
router.post('/update-account-name', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { payload } = req.body

    User.update({ name: payload }, { where : { id: accountId } })
        .then(res.send('success'))
        .catch(err => console.log(err))
})

router.post('/update-account-bio', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { payload } = req.body

    User.update({ bio: payload }, { where : { id: accountId } })
        .then(res.send('success'))
        .catch(err => console.log(err))
})

router.post('/mark-notifications-seen', authenticateToken, (req, res) => {
    const accountId = req.user.id
    const ids = req.body
    Notification
        .update({ seen: true }, { where: { id: ids, ownerId: accountId } })
        .then(res.send('success'))
})

// move to Space routes?
router.post('/respond-to-mod-invite', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { notificationId, userId, spaceId, response } = req.body

    if (response === 'accepted') {
        // create moderator relationship
        HolonUser.create({
            relationship: 'moderator',
            state: 'active',
            holonId: spaceId,
            userId: accountId
        }).then(() => {
            // update mod-invite notification
            Notification
                .update({ state: 'accepted', seen: true }, { where: { id: notificationId } })
                .then(() => {
                    // send new mod-invite-response notification to trigger user
                    Notification.create({
                        ownerId: userId,
                        type: 'mod-invite-response',
                        state: 'accepted',
                        seen: false,
                        holonAId: spaceId,
                        userId: accountId
                    }).then(() => {
                        res.status(200).send({ message: 'Success' })
                    }).catch(() => res.status(500).send({ message: 'Failed to create mod-invite-response notification' }))
                }).catch(() => res.status(500).send({ message: 'Failed to update mod-invite notification' }))
        }).catch(() => res.status(500).send({ message: 'Failed to create moderator relationship' }))
    } else if (response === 'rejected') {
        // update mod-invite notification
        Notification
            .update({ state: 'rejected', seen: true }, { where: { id: notificationId } })
            .then(() => {
                // send new mod-invite-response notification to trigger user
                Notification.create({
                    ownerId: userId,
                    type: 'mod-invite-response',
                    state: 'rejected',
                    seen: false,
                    holonAId: spaceId,
                    userId: accountId
                }).then(() => {
                    res.status(200).send({ message: 'Success' })
                }).catch(() => res.status(500).send({ message: 'Failed to create mod-invite-response notification' }))
            }).catch(() => res.status(500).send({ message: 'Failed to update mod-invite notification' }))
    }
})

router.post('/respond-to-weave-invite', authenticateToken, async (req, res) => {
    const accountId = req.user.id
    const { postId, notificationId, response } = req.body

    const updateUserPostState = new Promise((resolve) => {
        UserPost
            .update({ state: response }, { where: { postId, userId: accountId } })
            .then(() => {
                UserPost
                    .findAll({ where: { postId, type: 'weave', relationship: 'player' }})
                    .then(async (players) => {
                        if (players.find((p) => p.state === 'pending')) resolve()
                        else {
                            const firstPlayerId = players.find((p) => p.index === 1).userId
                            const firstPlayer = await User.findOne({ where: { id: firstPlayerId }, attributes: ['email', 'name'] })
                            const createMoveNotification = Notification.create({
                                type: 'weave-move',
                                ownerId: firstPlayerId,
                                postId: postId,
                                seen: false,
                            })
                            const sendMoveEmail = sgMail.send({
                                to: firstPlayer.email,
                                from: {
                                    email: 'admin@weco.io',
                                    name: 'we { collective }'
                                },
                                subject: 'New notification',
                                text: `
                                    Hi ${firstPlayer.name}, it's your move!
                                    Add a new bead to the weave on weco: https://${config.appURL}/p/${postId}
                                `,
                                html: `
                                    <p>
                                        Hi ${firstPlayer.name},
                                        <br/>
                                        It's your move!
                                        <br/>
                                        Add a new bead to the <a href='${config.appURL}/p/${postId}'>weave</a> on weco.
                                    </p>
                                `,
                            })
                            Promise.all([createMoveNotification, sendMoveEmail]).then(() => resolve())
                        }
                    })
            })
    })
    const updateNotification = await Notification.update({ state: response }, { where: { id: notificationId } })

    Promise.all([updateUserPostState, updateNotification]).then(res.status(200).json({ message: 'Success' }))
})

module.exports = router