module.exports = {
    up: (queryInterface, Sequelize) => {
        return queryInterface.sequelize.transaction(t => {
            return Promise.all([
                queryInterface.addColumn('MultiplayerStrings', 'postId', {
                    type: Sequelize.DataTypes.INTEGER
                }, { transaction: t })
            ]);
        });
    },
    
    down: (queryInterface, Sequelize) => {
        return queryInterface.sequelize.transaction(t => {
            return Promise.all([
                queryInterface.removeColumn('MultiplayerStrings', 'postId', { transaction: t }),
            ]);
        });
    }
};